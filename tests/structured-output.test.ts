import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import {
    createExecutionRequest,
    executeRequest,
    resumeRequest,
} from '../src/cli.ts';
import { readStructuredResult } from '../src/agents/structured-result.ts';
import { RunStore } from '../src/run-storage.ts';
import { createGitFixture } from './helpers/git.ts';
import { createMockProvider, TEST_MODEL } from './helpers/runtime.ts';

const result = {
    schemaVersion: 1,
    status: 'completed',
    summary: 'Sector has three direct subclasses.',
    questions: [],
};
const finish = (data: object) =>
    fauxAssistantMessage(fauxToolCall('submit_orchestrator_result', data), {
        stopReason: 'toolUse',
    });

for (const scenario of [
    'direct',
    'prose',
    'invalid',
    'invalid-schema',
    'never-finishes',
] as const) {
    test(`structured terminal result: ${scenario}`, async (t) => {
        const repo = await createGitFixture(t);
        const store = new RunStore({ root: join(dirname(repo.path), 'state') });
        const request = await createExecutionRequest({
            repo: repo.path,
            prompt: 'What different types of Sector subclass are there?',
            env: { ...repo.env, FLUE_AGENT_MODEL: TEST_MODEL },
        });
        const prose = fauxAssistantMessage('**Sector** is abstract.');
        const responses =
            scenario === 'never-finishes'
                ? [prose, prose, prose]
                : [
                      ...(scenario === 'prose' ? [prose] : []),
                      ...(scenario === 'invalid'
                          ? [finish({ ...result, status: 'needs_input' })]
                          : []),
                      ...(scenario === 'invalid-schema'
                          ? [finish({ ...result, status: 'invented-status' })]
                          : []),
                      finish(result),
                  ];
        const model = createMockProvider(responses);
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
        if (scenario === 'never-finishes') {
            await assert.rejects(run(), /Agent run failed/);
            assert.equal((await store.read(id)).status, 'failed');
        } else {
            assert.equal(await run(), result.summary);
            assert.equal((await store.read(id)).status, 'completed');
        }
    });
}

test('missing result metadata cannot fall back to assistant text', () => {
    assert.throws(() => readStructuredResult(), /Invalid orchestrator result/);
    assert.throws(
        () => readStructuredResult({ text: JSON.stringify(result) }),
        /Invalid orchestrator result/,
    );
});

test('needs-input result survives restart but cannot satisfy the resumed response', async (t) => {
    const repo = await createGitFixture(t);
    const store = new RunStore({ root: join(dirname(repo.path), 'state') });
    const request = await createExecutionRequest({
        repo: repo.path,
        prompt: 'Explain the chosen Sector implementation.',
        env: { ...repo.env, FLUE_AGENT_MODEL: TEST_MODEL },
    });
    const model = createMockProvider([
        finish({
            ...result,
            status: 'needs_input',
            summary: 'Choose a Sector.',
            questions: ['Which Sector implementation?'],
        }),
    ]);
    let id = '';
    await executeRequest(request, {
        store,
        modelTransport: { check: async () => {}, create: () => model.provider },
        onReport: (report) => {
            id = report.id;
        },
    });
    assert.equal((await store.read(id)).status, 'needs_input');
    const resumedModel = createMockProvider([
        fauxAssistantMessage('Here is a Markdown answer.'),
        finish(result),
    ]);
    assert.equal(
        await resumeRequest(id, 'The transit Sector.', {
            store,
            modelTransport: {
                check: async () => {},
                create: () => resumedModel.provider,
            },
        }),
        result.summary,
    );
    assert.equal((await store.read(id)).status, 'completed');
});
