import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { workspaceLocal } from '../src/sandboxes/workspace-local.ts';
import { test } from 'node:test';
import { DEFAULT_CONFIGURATION } from '../src/config.ts';
import { preflightGitRepository } from '../src/git-preflight.ts';
import { RunStore } from '../src/run-storage.ts';
import { WorkspaceManager } from '../src/workspaces.ts';
import { checkpointRun, loadContinuation, lockRun } from '../src/resumption.ts';
import { createGitFixture } from './helpers/git.ts';

test('resume retains identity and workspace and refuses changed repository or workspace', async (t) => {
    const repo = await createGitFixture(t);
    const store = new RunStore({ root: join(dirname(repo.path), 'data') });
    const configuration = DEFAULT_CONFIGURATION;
    const run = await store.create({ repository: repo.path, configuration });
    const repositoryState = await preflightGitRepository(repo.path);
    const workspace = await new WorkspaceManager(store).create(
        run.id,
        repositoryState,
    );
    const request = {
        prompt: 'implement objective',
        repository: repo.path,
        repositoryState,
        configuration,
    };
    await writeFile(join(workspace, 'partial.txt'), 'partial work');
    await checkpointRun(store, run.id, request);
    await store.update(run.id, { status: 'needs_input' });
    await assert.rejects(loadContinuation(store, run.id), /requires an answer/);
    assert.deepEqual(await loadContinuation(store, run.id, 'yes'), request);
    assert.equal((await store.read(run.id)).conversationId, run.conversationId);
    assert.equal((await store.read(run.id)).locations.workspace, workspace);
    await repo.write('README.md', 'changed');
    await assert.rejects(loadContinuation(store, run.id, 'yes'), /fingerprint/);
    await repo.git('checkout', '--', 'README.md');
    await writeFile(join(workspace, 'partial.txt'), 'external change');
    await assert.rejects(loadContinuation(store, run.id, 'yes'), /fingerprint/);
    assert.equal((await store.read(run.id)).status, 'needs_input');
});

test('run cancellation stops command descendants and prevents further writes', async (t) => {
    const repo = await createGitFixture(t);
    const controller = new AbortController();
    const sandbox = await workspaceLocal({
        cwd: repo.path,
        env: {},
        checkLimit: async () => {},
        commandTimeoutMs: 10000,
        signal: controller.signal,
    }).createSandbox({ id: 'cancellation' });
    const execution = sandbox.exec(
        '(sleep 1; echo survived > survivor) & wait',
    );
    const settled = assert.rejects(execution, { name: 'AbortError' });
    await delay(100);
    controller.abort();
    await settled;
    await delay(1100);
    await assert.rejects(readFile(join(repo.path, 'survivor')), {
        code: 'ENOENT',
    });
    await assert.rejects(sandbox.writeFile('later', 'no'), {
        name: 'AbortError',
    });
});

test('exclusive resume ownership is released explicitly', async (t) => {
    const repo = await createGitFixture(t);
    const store = new RunStore({ root: join(dirname(repo.path), 'data') });
    const run = await store.create({
        repository: repo.path,
        configuration: DEFAULT_CONFIGURATION,
    });
    const unlock = await lockRun(store, run.id);
    await assert.rejects(lockRun(store, run.id), { code: 'EEXIST' });
    await unlock();
    await (await lockRun(store, run.id))();
    await assert.rejects(loadContinuation(store, run.id), /not resumable/);
});
