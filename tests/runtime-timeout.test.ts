import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createExecutionRequest, executeRequest } from '../src/cli.ts';
import { RunStore } from '../src/run-storage.ts';
import { Orchestrator } from '../src/agents/orchestrator.ts';
import { DEFAULT_CONFIGURATION } from '../src/config.ts';
import { createGitFixture } from './helpers/git.ts';
import { createMockProvider, TEST_MODEL } from './helpers/runtime.ts';

test('default orchestrator also declares the application timeout', () => {
    assert.equal(
        Orchestrator.durability.timeoutMs,
        DEFAULT_CONFIGURATION.runTimeoutMs,
    );
});

for (const timeout of ['2h', '20m']) {
    test(`Flue persists the configured ${timeout} submission timeout`, async (t) => {
        const repo = await createGitFixture(t);
        const store = new RunStore({ root: join(dirname(repo.path), 'state') });
        const request = await createExecutionRequest({
            repo: repo.path,
            prompt: 'Answer without changing files.',
            env: {
                ...repo.env,
                FLUE_AGENT_MODEL: TEST_MODEL,
                FLUE_AGENT_RUN_TIMEOUT: timeout,
            },
        });
        const model = createMockProvider([
            fauxAssistantMessage(
                fauxToolCall('submit_orchestrator_result', {
                    schemaVersion: 1,
                    status: 'completed',
                    summary: 'Done.',
                    questions: [],
                    failureWaivers: [],
                }),
                { stopReason: 'toolUse' },
            ),
        ]);
        let id = '';
        await executeRequest(request, {
            store,
            modelTransport: {
                check: async () => {},
                create: () => model.provider,
            },
            onReport: (report) => {
                id = report.id;
            },
        });
        const db = new DatabaseSync(
            join(store.runDirectory(id), 'conversation.sqlite'),
            { readOnly: true },
        );
        try {
            const rows = db
                .prepare(
                    'SELECT timeout_at - started_at AS timeout FROM flue_agent_submissions',
                )
                .all();
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.timeout, request.configuration.runTimeoutMs);
        } finally {
            db.close();
        }
    });
}
