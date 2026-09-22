import assert from 'node:assert/strict';
import {
    chmod,
    lstat,
    readFile,
    readlink,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
    DEFAULT_CONFIGURATION,
    restrictedAgentEnvironment,
} from '../src/config.ts';
import {
    assertGitFingerprint,
    preflightGitRepository,
    runGit,
} from '../src/git-preflight.ts';
import { RunStore, type RunStatus } from '../src/run-storage.ts';
import {
    WorkspaceManager,
    WorkspaceLimitError,
    workspaceSize,
} from '../src/workspaces.ts';
import { workspaceLocal } from '../src/sandboxes/workspace-local.ts';
import { createGitFixture } from './helpers/git.ts';
import { executeRequest } from '../src/cli.ts';

async function fixture(t: TestContext, configuration = DEFAULT_CONFIGURATION) {
    const repo = await createGitFixture(t);
    const now = new Date();
    const store = new RunStore({
        root: join(dirname(repo.path), 'data'),
        now: () => now,
    });
    const run = await store.create({ repository: repo.path, configuration });
    const manager = new WorkspaceManager(store, repo.env);
    return { repo, store, run, manager };
}

test('detached workspace is recorded, isolated, and removed only after publication', async (t) => {
    const { repo, store, run, manager } = await fixture(t);
    const baseline = await preflightGitRepository(repo.path, { env: repo.env });
    const workspace = await manager.create(run.id, baseline);
    assert.equal((await store.read(run.id)).locations.workspace, workspace);
    const state = await preflightGitRepository(workspace, { env: repo.env });
    assert.equal(state.detached, true);
    assert.equal(state.head, baseline.head);
    await writeFile(join(workspace, 'README.md'), 'agent change');
    await assertGitFingerprint(baseline, { env: repo.env });
    await assert.rejects(manager.remove(run.id), /active/);
    await manager.finish(run.id, 'completed');
    assert.equal(
        await manager.cleanupExpired(run.id, Date.now() + 1e12),
        false,
    );
    await manager.afterPublication(run.id);
    await manager.afterPublication(run.id);
    await manager.remove(run.id);
    assert.equal((await store.read(run.id)).locations.workspace, null);
    assert.equal(
        (await repo.git('worktree', 'list', '--porcelain')).includes(workspace),
        false,
    );
    await assert.rejects(lstat(workspace), { code: 'ENOENT' });
    await assertGitFingerprint(baseline, { env: repo.env });
});

test('copies staged, unstaged, binary, deleted, renamed, executable and untracked symlink state', async (t) => {
    const { repo, run, manager } = await fixture(t);
    await repo.write('deleted', 'delete me');
    await repo.write('renamed', 'rename me');
    await repo.write('binary', 'initial');
    await repo.git('add', '.');
    await repo.git('commit', '-m', 'files');
    await repo.write('README.md', 'staged\n');
    await repo.git('add', 'README.md');
    await repo.write('README.md', 'unstaged\n');
    await repo.git('mv', 'renamed', 'new name');
    await rm(join(repo.path, 'deleted'));
    await writeFile(join(repo.path, 'binary'), Buffer.from([0, 1, 255, 17]));
    await repo.write('new dir/script', '#!/bin/sh\necho hi\n');
    await chmod(join(repo.path, 'new dir/script'), 0o755);
    await symlink('README.md', join(repo.path, 'link'));
    const baseline = await preflightGitRepository(repo.path, {
        allowDirty: true,
        env: repo.env,
    });
    const workspace = await manager.create(run.id, baseline);
    const copied = await preflightGitRepository(workspace, {
        allowDirty: true,
        env: repo.env,
    });
    assert.deepEqual(copied.index, baseline.index);
    assert.deepEqual(copied.worktree, baseline.worktree);
    assert.equal(await readlink(join(workspace, 'link')), 'README.md');
    assert.notEqual(
        (await lstat(join(workspace, 'new dir/script'))).mode & 0o111,
        0,
    );
    assert.deepEqual(
        await readFile(join(workspace, 'binary')),
        Buffer.from([0, 1, 255, 17]),
    );
    await assertGitFingerprint(baseline, { env: repo.env });
});

test('rejects baseline changes without provisioning a workspace', async (t) => {
    const { repo, store, run, manager } = await fixture(t);
    const baseline = await preflightGitRepository(repo.path, { env: repo.env });
    await repo.write('README.md', 'changed');
    await assert.rejects(manager.create(run.id, baseline), {
        code: 'repository_changed',
    });
    assert.equal((await store.read(run.id)).locations.workspace, null);
});

for (const status of [
    'failed',
    'blocked',
    'interrupted',
    'needs_input',
] as const) {
    test(`retains ${status} until configured expiry and cleanup is repeatable`, async (t) => {
        const { repo, store, run, manager } = await fixture(t, {
            ...DEFAULT_CONFIGURATION,
            retentionMs: 1_000_000_000_000,
        });
        const workspace = await manager.create(
            run.id,
            await preflightGitRepository(repo.path, { env: repo.env }),
        );
        await manager.finish(run.id, status);
        const record = await store.read(run.id);
        const stoppedAt = Date.parse(record.timestamps.updatedAt);
        assert.equal(
            await manager.cleanupExpired(
                run.id,
                stoppedAt + record.configuration.retentionMs - 1,
            ),
            false,
        );
        assert.equal(
            await manager.cleanupExpired(
                run.id,
                stoppedAt + record.configuration.retentionMs,
            ),
            true,
        );
        assert.equal(
            await manager.cleanupExpired(
                run.id,
                stoppedAt + record.configuration.retentionMs,
            ),
            false,
        );
        assert.equal((await store.read(run.id)).locations.workspace, null);
        assert.equal(
            (await repo.git('worktree', 'list')).includes(workspace),
            false,
        );
    });
}

test('zero retention deletes stopped failures immediately; sweep preserves active runs', async (t) => {
    const { repo, store, run, manager } = await fixture(t, {
        ...DEFAULT_CONFIGURATION,
        retentionMs: 0,
    });
    await manager.create(
        run.id,
        await preflightGitRepository(repo.path, { env: repo.env }),
    );
    await manager.sweep();
    assert.notEqual((await store.read(run.id)).locations.workspace, null);
    await manager.finish(run.id, 'failed');
    assert.equal((await store.read(run.id)).locations.workspace, null);
    await manager.sweep();
});

test('oversized initial workspace is blocked and retained without original changes', async (t) => {
    const { repo, run, store, manager } = await fixture(t, {
        ...DEFAULT_CONFIGURATION,
        workspaceLimitBytes: 1,
    });
    const baseline = await preflightGitRepository(repo.path, { env: repo.env });
    await assert.rejects(manager.create(run.id, baseline), WorkspaceLimitError);
    await manager.finish(run.id, 'failed');
    assert.equal((await store.read(run.id)).status, 'blocked');
    assert.notEqual((await store.read(run.id)).locations.workspace, null);
    await assertGitFingerprint(baseline, { env: repo.env });
});

test('sandbox confines ordinary paths and commands run in workspace with sticky size enforcement', async (t) => {
    const { repo, run, store, manager } = await fixture(t, {
        ...DEFAULT_CONFIGURATION,
        workspaceLimitBytes: 4096,
    });
    const baseline = await preflightGitRepository(repo.path, { env: repo.env });
    const workspace = await manager.create(run.id, baseline);
    const sandbox = await workspaceLocal({
        cwd: workspace,
        env: restrictedAgentEnvironment(repo.env),
        checkLimit: () => manager.checkLimit(run.id),
        commandTimeoutMs: 5000,
    }).createSandbox({ id: run.id });
    await sandbox.writeFile('nested/file', 'new file');
    assert.equal(
        await readFile(join(workspace, 'nested/file'), 'utf8'),
        'new file',
    );
    await assert.rejects(
        sandbox.writeFile(join(repo.path, 'README.md'), 'unsafe'),
        /outside/,
    );
    await assert.rejects(sandbox.writeFile('../escape', 'unsafe'), /outside/);
    await assert.rejects(sandbox.writeFile('.git', 'unsafe'), /outside/);
    await symlink(repo.path, join(workspace, 'escape'));
    await assert.rejects(
        sandbox.writeFile('escape/README.md', 'unsafe'),
        /outside/,
    );
    await assert.rejects(sandbox.exec('pwd', { cwd: repo.path }), /outside/);
    const result = await sandbox.exec('printf changed > README.md; pwd');
    assert.equal(result.stdout.trim(), workspace);
    // Symlink target contents are not counted.
    assert.ok((await workspaceSize(workspace)) < 4096);
    await assert.rejects(
        sandbox.writeFile('large', 'a'.repeat(5000)),
        WorkspaceLimitError,
    );
    assert.equal((await store.read(run.id)).status, 'blocked');
    await rm(join(workspace, 'large'));
    await assert.rejects(sandbox.writeFile('later', 'no'), WorkspaceLimitError);
    await assertGitFingerprint(baseline, { env: repo.env });
});

test('size monitoring interrupts a running command and blocks the run', async (t) => {
    const { repo, run, store, manager } = await fixture(t, {
        ...DEFAULT_CONFIGURATION,
        workspaceLimitBytes: 4096,
    });
    const workspace = await manager.create(
        run.id,
        await preflightGitRepository(repo.path, { env: repo.env }),
    );
    const sandbox = await workspaceLocal({
        cwd: workspace,
        env: restrictedAgentEnvironment(repo.env),
        checkLimit: () => manager.checkLimit(run.id),
        commandTimeoutMs: 10000,
    }).createSandbox({ id: run.id });
    await assert.rejects(
        sandbox.exec('head -c 5000 /dev/zero > large; sleep 10'),
        WorkspaceLimitError,
    );
    assert.equal((await store.read(run.id)).status, 'blocked');
});

test('CLI blocks oversized workspaces before model execution and retains their paths', async (t) => {
    const repo = await createGitFixture(t);
    const baseline = await preflightGitRepository(repo.path, { env: repo.env });
    const store = new RunStore({
        root: join(dirname(repo.path), 'cli-data'),
        generateId: () => 'cli-run',
    });
    await assert.rejects(
        executeRequest(
            {
                prompt: 'change README',
                repository: repo.path,
                repositoryState: baseline,
                configuration: {
                    ...DEFAULT_CONFIGURATION,
                    workspaceLimitBytes: 1,
                },
            },
            { store },
        ),
        WorkspaceLimitError,
    );
    const run = await store.read('cli-run');
    assert.equal(run.status, 'blocked');
    assert.equal(
        run.locations.workspace,
        join(store.runDirectory(run.id), 'workspace'),
    );
    await assertGitFingerprint(baseline, { env: repo.env });
});

test('cleanup refuses non-owned workspace locations', async (t) => {
    const { repo, store, run, manager } = await fixture(t);
    await store.update(run.id, {
        workspace: repo.path,
        status: 'failed' as RunStatus,
    });
    await assert.rejects(manager.remove(run.id), /unmanaged/);
    assert.equal(await repo.git('rev-parse', '--is-inside-work-tree'), 'true');
});

test('cleanup recovers when Git removal succeeded before record update', async (t) => {
    const { repo, run, store, manager } = await fixture(t);
    const workspace = await manager.create(
        run.id,
        await preflightGitRepository(repo.path, { env: repo.env }),
    );
    await manager.finish(run.id, 'failed');
    await runGit({ cwd: repo.path, env: repo.env }, [
        'worktree',
        'remove',
        '--force',
        workspace,
    ]);
    await manager.remove(run.id);
    assert.equal((await store.read(run.id)).locations.workspace, null);
});
