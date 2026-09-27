import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { observe, type FlueObservation } from '@flue/runtime';
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

for (const mode of ['no-commit', 'commit', 'rejected', 'malformed', 'corrected'] as const) {
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
            ...(mode === 'corrected' ? [tool('submit_specialist_result', {
                schemaVersion: 1, role: 'reviewer', summary: 'Checked README',
                findings: [{ severity: 'note', description: 'Checked', path: null, line: null }],
                validation: [], limitations: [],
            })] : []),
            (mode === 'corrected' ? (value: Record<string, unknown>) => tool('submit_specialist_result', value) : answer)({
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
                : tool('submit_orchestrator_result', {
                      schemaVersion: 1,
                      status: 'completed',
                      summary: 'Done',
                      questions: [],
                  }),
        ]);
        const observations: FlueObservation[] = [];
        const unsubscribe = observe(event => { observations.push(event); });
        t.after(unsubscribe);
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
        assert.ok(record.ledger.every((event) => Number.isInteger(event.at)));
        const audit = (await readFile(join(store.runDirectory(id), 'audit.ndjson'), 'utf8'))
            .trim().split('\n').map((line) => JSON.parse(line));
        assert.ok(audit.length > 0);
        assert.ok(audit.every((entry) => Number.isInteger(entry.timestamp)));
        assert.deepEqual(audit.map((entry) => entry.agent), ['implementer-1', 'reviewer-1']);
        const telemetry = (await readFile(join(store.runDirectory(id), 'execution-telemetry.jsonl'), 'utf8'))
            .trim().split('\n').map((line) => JSON.parse(line));
        for (const entry of audit) {
            assert.equal(typeof entry.taskId, 'string');
            const taskEvents = telemetry.filter((event) => event.taskId === entry.taskId);
            assert.ok(taskEvents.length > 0);
            assert.ok(taskEvents.every((event) => event.agent === entry.agent));
            assert.ok(record.ledger.some((event) =>
                event.agent === entry.agent && event.taskId === entry.taskId,
            ));
        }
        assert.ok(record.ledger.some((event) => event.agent === 'orchestrator'));
        if (mode === 'corrected') {
            const reviewer = replayLedger(record.ledger).delegations.find(entry => entry.role === 'reviewer');
            assert.ok(reviewer);
            const tasks = observations.filter(event => event.type === 'task_start' && event.agent === 'reviewer');
            assert.equal(tasks.length, 1);
            const submissions = observations.filter(event => event.type === 'tool' && event.toolName === 'submit_specialist_result');
            assert.equal(submissions.length, 2);
            assert.equal(new Set(submissions.map(event => event.conversationId)).size, 1);
            assert.equal(submissions[0]?.conversationId, tasks[0]?.conversationId);
            assert.equal(reviewer.failure, null);
            assert.equal(reviewer.retries, 1);
            assert.match(reviewer.malformedResults[0]?.issues.join() ?? '', /\$\.verdict/);
            assert.deepEqual(record.ledger.filter(e => 'id' in e.action && e.action.id === reviewer.id).map(e => e.action.type), ['start', 'malformed', 'retry', 'result']);
        }
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
        const commands = events.filter((event) => 'type' in event && event.type === 'command');
        const modelOutputs = events.filter((event) => 'event' in event && event.event === 'llm_output');
        assert.equal(commands.length, 2);
        assert.ok(modelOutputs.length > 0);
        assert.ok(modelOutputs.every((event) => 'outputTokens' in event));
        for (const event of commands) {
            assert.ok('ts' in event && typeof event.ts === 'number');
            assert.ok('agent' in event && typeof event.agent === 'string');
            assert.ok('taskId' in event && typeof event.taskId === 'string');
            assert.ok(!('timestamp' in event) && !('at' in event));
        }
        assert.equal(
            (await repo.git('rev-parse', 'HEAD')) === before,
            mode !== 'commit',
        );
        assert.equal(await repo.git('diff', '--cached'), '');
        assert.equal(
            await repo.git('status', '--porcelain'),
            (mode === 'no-commit' || mode === 'corrected') ? ' M README.md' : '',
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
