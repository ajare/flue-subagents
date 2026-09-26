import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../src/cli.ts';
import { DEFAULT_CONFIGURATION } from '../src/config.ts';
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
