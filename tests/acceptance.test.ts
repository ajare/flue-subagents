import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createExecutionRequest, executeRequest } from '../src/cli.ts';
import {
    completionEligibility,
    replayLedger,
} from '../src/delegation-ledger.ts';
import { RunStore } from '../src/run-storage.ts';
import { createGitFixture } from './helpers/git.ts';
import { createMockProvider, TEST_MODEL } from './helpers/runtime.ts';

const brief = [
    'Objective',
    'Acceptance criteria',
    'Constraints',
    'Context and evidence',
    'Prior decisions and results',
    'Role task',
    'Plan',
    'Diff',
    'Validation report',
    'Known limitations and unresolved issues',
]
    .map(
        (heading) =>
            `${heading}: Update README.md to Accepted and validate with grep.`,
    )
    .join('\n');
const answer = (value: object) => fauxAssistantMessage(JSON.stringify(value));
const tool = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

for (const mode of ['no-commit', 'commit', 'rejected', 'malformed'] as const) {
    test(`production runner disposable repository: ${mode}`, async (t) => {
        const repo = await createGitFixture(t);
        const before = await repo.git('rev-parse', 'HEAD');
        const store = new RunStore({ root: join(dirname(repo.path), 'state') });
        const request = await createExecutionRequest({
            repo: repo.path,
            prompt: 'Update README.md to Accepted.',
            env: { ...repo.env, FLUE_AGENT_MODEL: TEST_MODEL },
            commit: mode === 'commit',
        });
        const model = createMockProvider([
            tool('task', { agent: 'implementer', prompt: brief }),
            tool('implement_write_file', {
                path: 'README.md',
                content: 'Accepted\n',
            }),
            tool('implement_run_command', {
                command: 'grep -qx Accepted README.md',
            }),
            answer({
                schemaVersion: 1,
                role: 'implementer',
                summary: 'Updated README',
                changes: [{ path: 'README.md', summary: 'Accepted' }],
                commands: [],
                unresolvedIssues: [],
            }),
            tool('task', { agent: 'reviewer', prompt: brief }),
            tool('review_run_command', {
                command: 'grep -qx Accepted README.md',
            }),
            answer({
                schemaVersion: 1,
                role: 'reviewer',
                summary: 'Checked README',
                verdict: mode === 'rejected' ? 'blocked' : 'approved',
                findings:
                    mode === 'rejected'
                        ? [
                              {
                                  severity: 'blocking',
                                  description: 'Cannot approve',
                              },
                          ]
                        : [],
                validation: [
                    {
                        command: 'grep -qx Accepted README.md',
                        result: 'passed',
                        exitCode: 0,
                        summary: 'Matches',
                        scope: 'central',
                    },
                ],
                limitations: [],
            }),
            mode === 'malformed'
                ? fauxAssistantMessage('not JSON')
                : answer({
                      schemaVersion: 1,
                      status: 'completed',
                      summary: 'Done',
                      questions: [],
                  }),
        ]);
        const events: object[] = [];
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
                onEvent: (event) => events.push(event),
            });
        if (mode === 'malformed') await assert.rejects(run());
        else await run();
        const record = await store.read(id);
        const failed = mode === 'rejected' || mode === 'malformed';
        assert.equal(
            record.status,
            mode === 'malformed' ? 'failed' : failed ? 'blocked' : 'completed',
        );
        assert.equal(
            await readFile(join(repo.path, 'README.md'), 'utf8'),
            failed ? '# Test repository\n' : 'Accepted\n',
        );
        assert.equal(
            completionEligibility(record.ledger).eligible,
            mode !== 'rejected',
        );
        assert.ok(
            replayLedger(record.ledger).delegations.some(
                (entry) => entry.result?.role === 'reviewer',
            ),
        );
        assert.equal(events.length, 2);
        assert.equal(
            (await repo.git('rev-parse', 'HEAD')) === before,
            mode !== 'commit',
        );
        assert.equal(await repo.git('diff', '--cached'), '');
        assert.equal(
            await repo.git('status', '--porcelain'),
            mode === 'no-commit' ? ' M README.md' : '',
        );
        if (mode === 'commit') {
            assert.equal(
                await repo.git('rev-list', '--count', `${before}..HEAD`),
                '1',
            );
            assert.equal(await repo.git('show', 'HEAD:README.md'), 'Accepted');
        }
    });
}
