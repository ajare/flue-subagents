import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createExecutionRequest, executeRequest } from '../src/cli.ts';
import { RunStore } from '../src/run-storage.ts';
import { ResultCorrection } from '../src/result-correction.ts';
import { recoverTruncatedStream } from '../src/truncated-result-stream.ts';
import { resolveConfigurationSources } from '../src/config.ts';
import { buildReport, formatReport, publicEvents } from '../src/reporting.ts';
import {
    validateSubagentResult,
    ResultValidationError,
} from '../src/result-contracts.ts';
import { createGitFixture } from './helpers/git.ts';
import { createMockProvider, TEST_MODEL } from './helpers/runtime.ts';

const valid = {
    schemaVersion: 1,
    role: 'explorer',
    summary: 'Checked Layer dimensions.',
    findings: ['Checked arithmetic'],
    evidence: [],
    openQuestions: [],
};
const tool = (name: string, data: object) =>
    fauxAssistantMessage(fauxToolCall(name, data), { stopReason: 'toolUse' });
const partial =
    '{"schemaVersion":1,"role":"explorer","summary":"Layer","evidence":[{"observation":"PRIVATE WorldException';
// Faux reports ceil(visible characters / 4), reproducing the exact 32768 limit.
const truncated = fauxAssistantMessage(partial.padEnd(32768 * 4, 'x'), {
    stopReason: 'length',
});

for (const scenario of [
    'recovered',
    'repeated',
    'malformed',
    'budget',
] as const) {
    test(`runtime length-stop recovery: ${scenario}`, async (t) => {
        const repo = await createGitFixture(t);
        const store = new RunStore({ root: join(dirname(repo.path), 'state') });
        const request = await createExecutionRequest({
            repo: repo.path,
            prompt: 'Investigate Layer.',
            env: {
                ...repo.env,
                FLUE_AGENT_MODEL: TEST_MODEL,
                FLUE_AGENT_MAX_OUTPUT_TOKENS: '32768',
                FLUE_AGENT_MAX_DELEGATIONS: scenario === 'budget' ? '1' : '2',
            },
        });
        let originalSession: string | undefined;
        const model = createMockProvider([
            tool('task', {
                agent: 'explorer',
                prompt: 'Objective: Investigate Layer.\nRole task: Check dimensions.',
            }),
            (_context, options) => {
                originalSession = options?.sessionId;
                return truncated;
            },
            ...(scenario === 'budget'
                ? []
                : [
                      ((context, options) => {
                          assert.equal(options?.sessionId, originalSession);
                          assert.match(
                              JSON.stringify(context.messages),
                              /only corrective attempt/,
                          );
                          assert.match(
                              context.systemPrompt ?? '',
                              /one evidence item per distinct fact/,
                          );
                          return scenario === 'recovered'
                              ? tool('submit_specialist_result', valid)
                              : scenario === 'repeated'
                                ? truncated
                                : tool('submit_specialist_result', {});
                      }) satisfies import('@earendil-works/pi-ai').FauxResponseFactory,
                  ]),
            tool('submit_orchestrator_result', {
                schemaVersion: 1,
                status: 'completed',
                summary: 'Done',
                questions: [],
                failureWaivers: [],
            }),
        ]);
        let id = '';
        const run = () =>
            executeRequest(request, {
                store,
                modelTransport: {
                    check: async () => {},
                    create: () => model.provider,
                },
                onReport: (report) => {
                    id = report.id;
                },
            });
        if (scenario === 'recovered') assert.equal(await run(), 'Done');
        else await assert.rejects(run());
        const record = await store.read(id);
        assert.deepEqual(
            record.ledger
                .filter((event) => event.action.type !== 'patch')
                .map((event) => event.action.type),
            scenario === 'recovered'
                ? ['start', 'malformed', 'retry', 'result']
                : scenario === 'budget'
                  ? ['start', 'malformed', 'failure']
                  : ['start', 'malformed', 'retry', 'malformed', 'failure'],
        );
        const report = await buildReport(store, id);
        const diagnostic = report.resultContractDiagnostics[0];
        assert.equal(
            diagnostic?.status,
            scenario === 'recovered' ? 'recovered' : 'terminal',
        );
        assert.equal(diagnostic?.attempts[0]?.reasonCode, 'output_truncated');
        assert.equal(
            diagnostic?.attempts[0]?.configuredOutputTokenLimit,
            32768,
        );
        assert.equal(diagnostic?.attempts[0]?.outputTokens, 32768);
        assert.equal(diagnostic?.attempts[0]?.stopReason, 'length');
        assert.equal(diagnostic?.attempts[0]?.reachedValidation, true);
        if (scenario === 'repeated' || scenario === 'malformed')
            assert.equal(
                diagnostic?.attempts[1]?.reasonCode,
                scenario === 'repeated'
                    ? 'output_truncated'
                    : 'invalid_subagent_result',
            );
        assert.match(formatReport(report), /output_truncated/);
        assert.doesNotMatch(
            JSON.stringify(publicEvents(record)),
            /PRIVATE|WorldException/,
        );
        assert.equal(
            new Set(
                record.ledger
                    .filter((event) => event.action.type !== 'patch')
                    .map((event) => event.taskId),
            ).size,
            1,
        );
        assert.equal(
            new Set(
                record.ledger
                    .filter((event) => event.action.type !== 'patch')
                    .map((event) => event.agent),
            ).size,
            1,
        );
        const performance = report.agentPerformance.find(
            (agent) => agent.agent === 'explorer-1',
        );
        assert.equal(performance?.llmCalls, scenario === 'budget' ? 1 : 2);
        assert.equal(model.state.callCount, scenario === 'budget' ? 3 : 4);
        const telemetry = await readFile(
            join(store.runDirectory(id), 'execution-telemetry.jsonl'),
            'utf8',
        );
        const turns = telemetry
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter(
                (event) =>
                    event.event === 'llm_output' &&
                    event.agent === 'explorer-1',
            );
        assert.equal(turns[0].stopReason, 'length');
        assert.equal(turns[0].outputTokens, 32768);
        assert.doesNotMatch(telemetry, /PRIVATE|WorldException/);
    });
}

test('length-stopped tool arguments cannot be accepted even when provider salvage passes schema', async () => {
    const original = fauxAssistantMessage(
        fauxToolCall('submit_specialist_result', valid),
        { stopReason: 'length' },
    );
    let attempts = 0;
    const correction = new ResultCorrection('explorer', {
        prompt: 'Inspect',
        consume: () => {
            attempts++;
        },
    });
    const stream = recoverTruncatedStream(
        {
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'done' as const,
                    reason: 'length' as const,
                    message: original,
                };
            },
            async result() {
                return original;
            },
        },
        correction,
        32768,
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const response = await stream.result();
    assert.equal(events.at(-1)?.type, 'done');
    assert.equal(response.stopReason, 'toolUse');
    assert.equal(response.usage, original.usage);
    assert.match((await correction.submit({})) ?? '', /truncated/);
    assert.equal(correction.result, undefined);
    assert.equal(attempts, 1);
    await correction.submit(valid);
    assert.deepEqual(correction.result, valid);
});

test('presentation limits resolve through configuration and reject invalid settings', () => {
    const config = resolveConfigurationSources({
        env: { FLUE_AGENT_RESULT_MAX_STRING_LENGTH: '2000' },
        project: { resultMaxCollectionItems: 100 },
    });
    assert.equal(config.resultMaxStringLength, 2000);
    assert.equal(config.resultMaxCollectionItems, 100);
    assert.throws(
        () => resolveConfigurationSources({ project: { resultMaxLength: 0 } }),
        /positive integer/,
    );
});

test('complete overlarge results have actionable paths and configurable presentation limits', () => {
    const output = { ...valid, findings: ['a', 'b'], summary: 'long summary' };
    assert.throws(
        () =>
            validateSubagentResult('explorer', output, {
                maxStringLength: 5,
                maxCollectionItems: 1,
                maxResultLength: 100,
            }),
        (error: unknown) => {
            assert.ok(error instanceof ResultValidationError);
            assert.deepEqual(
                error.issues.map((issue) => issue.path),
                ['$.summary', '$.findings', '$'],
            );
            assert.match(error.message, /compact|deduplicate/);
            return true;
        },
    );
    assert.deepEqual(validateSubagentResult('explorer', output), output);
});
