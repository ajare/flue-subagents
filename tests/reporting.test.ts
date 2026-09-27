import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.ts';
import { DEFAULT_CONFIGURATION } from '../src/config.ts';
import { replayLedger } from '../src/delegation-ledger.ts';
import {
    buildReport,
    cleanupRun,
    EXIT_CODES,
    formatReport,
    listRuns,
    publicEvents,
    saveOutcome,
} from '../src/reporting.ts';
import { lockRun } from '../src/resumption.ts';
import { RunStore } from '../src/run-storage.ts';
import { ExecutionTelemetry } from '../src/execution-telemetry.ts';
import type { FlueObservation } from '@flue/runtime';
import { createGitFixture } from './helpers/git.ts';

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'flue-report-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, 'repository');
    await mkdir(repository);
    const store = new RunStore({ root: join(root, 'data') });
    const run = await store.create({
        repository,
        configuration: DEFAULT_CONFIGURATION,
    });
    return { store, run };
}

test('reports share outcomes and highlight limitations without reading private conversation data', async (t) => {
    const { store, run } = await fixture(t);
    await writeFile(
        join(store.runDirectory(run.id), 'conversation.sqlite'),
        'PRIVATE_REASONING_SENTINEL',
    );
    await store.update(run.id, {
        ledgerAction: {
            type: 'patch',
            patch: { revisionHash: 'revision', diffHash: 'diff' },
        },
    });
    await store.update(run.id, {
        ledgerAction: {
            type: 'start',
            id: 'review',
            role: 'reviewer',
            task: 'Check validation',
            parentId: null,
        },
    });
    await store.update(run.id, {
        ledgerAction: {
            type: 'result',
            id: 'review',
            result: {
                schemaVersion: 1,
                role: 'reviewer',
                verdict: 'approved_with_limitations',
                summary: 'Reviewed',
                findings: [
                    { severity: 'warning', description: 'Service unavailable' },
                ],
                validation: [
                    {
                        command: 'integration',
                        result: 'not_run',
                        exitCode: null,
                        summary: 'Offline',
                        scope: 'optional',
                    },
                ],
                limitations: ['Offline validation'],
            },
        },
    });
    await store.update(run.id, { status: 'blocked' });
    await saveOutcome(store, run.id, 'Unable to finish');
    const report = await buildReport(store, run.id);
    const human = formatReport(report);
    assert.equal(report.exitCode, 3);
    assert.equal(report.reducedConfidence, true);
    assert.match(human, /REDUCED-CONFIDENCE/);
    assert.match(human, /UNRESOLVED RISK: Service unavailable/);
    assert.match(human, /Offline validation/);
    assert.match(human, /Unable to finish/);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_REASONING/);
    const events = publicEvents(await store.read(run.id));
    assert.ok(events.every((event) => typeof event.ts === 'number'));
    assert.ok(events.every((event) => typeof event.agent === 'string'));
    assert.ok(events.every((event) => !('at' in event) && !('timestamp' in event)));
    assert.equal(events[2]?.verdict, 'approved_with_limitations');
    assert.ok(events[2]?.durationMs !== undefined);
});

test('inspect reconstructs safe preflight rejections, without failed specialist spans or names', async (t) => {
    const { store, run } = await fixture(t);
    const published: object[] = [];
    const telemetry = new ExecutionTelemetry(join(store.runDirectory(run.id), 'execution-telemetry.jsonl'), run.id, 'conversation', 16, 100, (event) => published.push(event));
    const emit = (event: object) => telemetry.observe({
        instanceId: 'conversation', timestamp: '2026-01-01T00:00:00.000Z', ...event,
    } as FlueObservation);
    const review = 'Role task: PRIVATE_PROMPT\nPlan: None\nDiff: None\nValidation report: None\nKnown limitations and unresolved issues: None';
    emit({ type: 'task_start', taskId: 'bad', agent: 'reviewer', prompt: review });
    emit({ type: 'task', taskId: 'bad', agent: 'reviewer', isError: true, result: 'PRIVATE_ERROR' });
    emit({ type: 'task_start', taskId: 'unknown', agent: 'PRIVATE_ROLE', prompt: 'PRIVATE_PROMPT' });
    emit({ type: 'task', taskId: 'unknown', agent: 'PRIVATE_ROLE', isError: true });
    emit({ type: 'task_start', taskId: 'good', agent: 'reviewer', prompt: `Objective: Review.\n${review}` });
    emit({ type: 'task', taskId: 'good', agent: 'reviewer', isError: false });
    telemetry.finish('completed');
    assert.equal(published.length, 2);
    assert.deepEqual((published[0] as { missingSections: string[] }).missingSections, ['Objective']);
    assert.doesNotMatch(JSON.stringify(published), /PRIVATE/);
    assert.deepEqual(replayLedger((await store.read(run.id)).ledger).delegations, []);
    for (const json of [false, true]) {
        let output = '';
        assert.equal(await runCli(['inspect', run.id, ...(json ? ['--json'] : [])], {
            env: { FLUE_AGENT_DATA_DIR: store.root },
            stdout: { write: (value) => { output += value; return true; } },
            stderr: { write: () => true },
        }), 0);
        assert.match(output, /delegation_rejected/);
        assert.match(output, /incomplete_briefing/);
        assert.match(output, /Objective/);
        assert.match(output, /unauthorized_role/);
        assert.doesNotMatch(output, /PRIVATE|reviewer-2/);
        if (json) assert.deepEqual(JSON.parse(output).delegationDiagnostics[0].missingSections, ['Objective']);
    }
    const records = (await readFile(join(store.runDirectory(run.id), 'execution-telemetry.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.filter((event) => event.type === 'subagent_start').map((event) => event.agent), ['reviewer-1']);
    assert.deepEqual(records.filter((event) => event.type === 'subagent_end').map((event) => event.status), ['completed']);
});

test('exit code mapping covers every lifecycle status', () => {
    assert.deepEqual(EXIT_CODES, {
        completed: 0,
        failed: 1,
        needs_input: 2,
        blocked: 3,
        interrupted: 130,
        running: 4,
    });
});

test('list, inspect and cleanup work without a model or Git preflight', async (t) => {
    const { store, run } = await fixture(t);
    await store.update(run.id, { status: 'failed' });
    for (const args of [
        ['list'],
        ['inspect', run.id],
        ['cleanup', run.id],
        ['cleanup', '--expired'],
    ]) {
        let output = '';
        const code = await runCli([...args, '--json'], {
            env: { FLUE_AGENT_DATA_DIR: store.root },
            stdout: {
                write: (value) => {
                    output += value;
                    return true;
                },
            },
            stderr: { write: () => true },
        });
        assert.equal(code, 0);
        assert.ok(JSON.parse(output).type);
    }
    assert.equal((await listRuns(store)).length, 1);
});

test('cleanup respects execution locks and rejects traversal and symlink run directories', async (t) => {
    const { store, run } = await fixture(t);
    const unlock = await lockRun(store, run.id);
    await assert.rejects(cleanupRun(store, run.id));
    await unlock();
    await assert.rejects(cleanupRun(store, '../repository'));
    await symlink(
        store.runDirectory(run.id),
        join(store.runsDirectory, 'alias'),
    );
    await assert.rejects(store.read('alias'));
    assert.equal((await listRuns(store)).length, 1);
});

test('execution returns the persisted blocked exit code and JSON report on early failure', async (t) => {
    const repo = await createGitFixture(t);
    const root = await mkdtemp(join(tmpdir(), 'flue-cli-report-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let output = '';
    let warning = '';
    const code = await runCli(
        ['--json', '--repo', repo.path, 'change README'],
        {
            env: {
                ...repo.env,
                FLUE_AGENT_DATA_DIR: root,
                FLUE_AGENT_WORKSPACE_LIMIT: '1',
            },
            stdout: {
                write: (value) => {
                    output += value;
                    return true;
                },
            },
            stderr: {
                write: (value) => {
                    warning += value;
                    return true;
                },
            },
        },
    );
    assert.equal(code, 3);
    const lines = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const report = lines.at(-1);
    assert.equal(report.type, 'report');
    assert.equal(report.status, 'blocked');
    assert.equal(report.exitCode, code);
    assert.match(warning, /TRUSTED-LOCAL/);
    assert.equal(
        (await buildReport(new RunStore({ root }), report.id)).status,
        'blocked',
    );
});
