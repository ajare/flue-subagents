import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createExecutionRequest, executeRequest } from '../src/cli.ts';
import { RunStore } from '../src/run-storage.ts';
import {
    checkModelConnectivity,
    createModelProvider,
} from '../src/model-provider.ts';
import { buildReport, formatReport } from '../src/reporting.ts';
import {
    statsFetch,
    takeProviderStats,
    withProviderStats,
} from '../src/provider-stats.ts';
import { createGitFixture } from './helpers/git.ts';

const timings = {
    prompt_n: 57,
    predicted_n: 29,
    prompt_ms: 604.4,
    predicted_ms: 788.9,
    prompt_per_second: 94.308,
    predicted_per_second: 36.76,
    cache_n: 0,
    disk_restore_n: 0,
    disk_restore_ms: 0,
    prefix_n: 40,
    draft_n: 1,
    draft_n_accepted: 2,
};
const usage = {
    prompt_tokens: 57,
    completion_tokens: 29,
    total_tokens: 86,
    completion_tokens_details: {
        reasoning_tokens: 26,
        reasoning_closed_by: 'answer_room',
    },
};

const sse = (value: object) => `data: ${JSON.stringify(value)}\r\n\r\n`;

test('stream stats survive fragmented SSE, duplicate metadata and concurrent turns without changing bytes', async () => {
    await Promise.all(
        [1, 2].map(async (n) => {
            const body =
                sse({ choices: [{ delta: { content: 'private ü text' } }] }) +
                sse({ timings: { ...timings, predicted_n: n } }) +
                sse({ usage, timings: { ...timings, predicted_n: n } }) +
                'data: [DONE]\r\n\r\n';
            const bytes = new TextEncoder().encode(body);
            const response = await withProviderStats(
                `t${n}`,
                'test',
                async () => {
                    const wrapped = statsFetch(
                        async () =>
                            new Response(
                                new ReadableStream({
                                    start(controller) {
                                        for (const byte of bytes)
                                            controller.enqueue(
                                                new Uint8Array([byte]),
                                            );
                                        controller.close();
                                    },
                                }),
                                {
                                    headers: {
                                        'content-type': 'text/event-stream',
                                    },
                                },
                            ),
                    );
                    return wrapped('http://unused');
                },
            );
            // Consumption is deliberately outside the interceptor's async scope.
            assert.equal(await response.text(), body);
            const stats = takeProviderStats(`t${n}`);
            assert.deepEqual(stats, {
                timings: { ...timings, predicted_n: n },
                usage,
            });
            assert.ok(!JSON.stringify(stats).includes('private'));
            assert.deepEqual(takeProviderStats(`t${n}`), {});
        }),
    );
});

test('real provider and runtime deliver server statistics on llm_output', async (t) => {
    const server = createServer(async (request, response) => {
        if (request.method === 'GET' && request.url === '/v1/models') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
                JSON.stringify({
                    object: 'list',
                    data: [
                        {
                            id: 'halogen-qwen3.8-flash-next',
                            max_tokens_cap: 65_536,
                        },
                    ],
                }),
            );
            return;
        }
        for await (const _chunk of request) {
            /* consume request */
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
            sse({
                id: 'completion-test',
                model: 'test',
                choices: [
                    {
                        index: 0,
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: 'finish-1',
                                    type: 'function',
                                    function: {
                                        name: 'submit_orchestrator_result',
                                        arguments: JSON.stringify({
                                            schemaVersion: 1,
                                            status: 'completed',
                                            summary: 'Done',
                                            questions: [],
                                        }),
                                    },
                                },
                            ],
                        },
                        finish_reason: null,
                    },
                ],
            }) +
                sse({
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'tool_calls' },
                    ],
                    timings,
                }) +
                sse({ choices: [], usage, timings }) +
                'data: [DONE]\n\n',
        );
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
    );
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const repo = await createGitFixture(t);
    const request = await createExecutionRequest({
        repo: repo.path,
        prompt: 'Say done.',
        env: {
            ...repo.env,
            FLUE_AGENT_ENDPOINT: `http://127.0.0.1:${address.port}/v1`,
        },
    });
    const events: object[] = [];
    const store = new RunStore({ root: join(dirname(repo.path), 'state') });
    let runId = '';
    await executeRequest(request, {
        store,
        onReport: (report) => {
            runId = report.id;
        },
        modelTransport: {
            check: checkModelConnectivity,
            create: createModelProvider,
        },
        onEvent: (event) => events.push(event),
    });
    const event = events.find(
        (event) => 'event' in event && event.event === 'llm_output',
    );
    assert.ok(
        event && 'timings' in event && 'usage' in event,
        JSON.stringify(events),
    );
    const report = await buildReport(store, runId);
    assert.equal(report.agentPerformance[0].averageTokensPerSecond,
        timings.predicted_n * 1000 / timings.predicted_ms);
    assert.equal(report.agentPerformance[0].llmCalls, 1);
    assert.match(formatReport(report), /Performance summary:\nWall-clock time: .* s\norchestrator: 36\.76 token\/s/);
    assert.deepEqual(event.timings, timings);
    assert.deepEqual(event.usage, usage);
    assert.ok(
        'contextTokens' in event &&
            'contextUtilization' in event &&
            'providerMaxOutputTokens' in event,
    );
    assert.equal(event.contextTokens, usage.prompt_tokens);
    assert.equal(
        event.contextUtilization,
        usage.prompt_tokens / request.configuration.contextWindow,
    );
    assert.equal(event.providerMaxOutputTokens, 65_536);
});
