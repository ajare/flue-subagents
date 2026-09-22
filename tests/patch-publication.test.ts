import assert from 'node:assert/strict';
import {
    chmod,
    lstat,
    mkdir,
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
import { workspaceLocal } from '../src/sandboxes/workspace-local.ts';
import {
    assertGitFingerprint,
    preflightGitRepository,
} from '../src/git-preflight.ts';
import { PatchManager } from '../src/patch-publication.ts';
import {
    completionEligibility,
    replayLedger,
} from '../src/delegation-ledger.ts';
import { RunStore } from '../src/run-storage.ts';
import { WorkspaceManager } from '../src/workspaces.ts';
import { createGitFixture } from './helpers/git.ts';

const stores = new WeakMap<WorkspaceManager, RunStore>();
async function approveAndComplete(workspaces: WorkspaceManager, id: string) {
    const store = stores.get(workspaces);
    assert.ok(store);
    await store.update(id, {
        ledgerAction: {
            type: 'start',
            id: 'publication-review',
            role: 'reviewer',
            task: 'independent review',
            parentId: null,
        },
    });
    await store.update(id, {
        ledgerAction: {
            type: 'result',
            id: 'publication-review',
            result: {
                schemaVersion: 1,
                role: 'reviewer',
                verdict: 'approved',
                summary: 'Reviewed',
                findings: [],
                validation: [],
                limitations: [],
            },
        },
    });
    await workspaces.finish(id, 'completed');
}

async function fixture(t: TestContext, dirty = false) {
    const repo = await createGitFixture(t);
    await repo.write('.gitignore', '*.generated\n');
    await repo.write('delete-me', 'old');
    await repo.git('add', '.');
    await repo.git('commit', '-m', 'baseline');
    if (dirty) {
        await repo.write('README.md', 'staged');
        await repo.git('add', 'README.md');
        await repo.write('README.md', 'unstaged');
        await repo.write('user-file', 'user data');
    }
    const baseline = await preflightGitRepository(repo.path, {
        allowDirty: true,
        env: repo.env,
    });
    const store = new RunStore({ root: join(dirname(repo.path), 'data') });
    const run = await store.create({
        repository: repo.path,
        configuration: DEFAULT_CONFIGURATION,
    });
    const workspaces = new WorkspaceManager(store, repo.env);
    stores.set(workspaces, store);
    const workspace = await workspaces.create(run.id, baseline);
    const patches = new PatchManager(store, repo.env);
    await patches.initialize(run.id, baseline);
    return { repo, baseline, store, run, workspaces, workspace, patches };
}

test('sandbox records file mutations and failed command side effects', async (t) => {
    const { patches, workspace, run, workspaces, repo } = await fixture(t);
    const sandbox = await workspaceLocal({
        cwd: workspace,
        env: restrictedAgentEnvironment(repo.env),
        checkLimit: () => workspaces.checkLimit(run.id),
        afterMutation: () => patches.capture(run.id),
        commandTimeoutMs: 5000,
    }).createSandbox({ id: run.id });
    await sandbox.writeFile('README.md', 'first');
    assert.equal((await patches.latest(run.id))?.sequence, 2);
    await sandbox.exec('printf second > README.md; exit 1').catch(() => {});
    const latest = await patches.latest(run.id);
    assert.equal(latest?.sequence, 3);
    assert.equal(
        Buffer.from(latest?.changes[0]?.after?.data ?? '', 'base64').toString(),
        'second',
    );
});

test('capture automatically invalidates ledger approval after workspace mutations', async (t) => {
    const { patches, workspace, run, store } = await fixture(t);
    await store.update(run.id, {
        ledgerAction: {
            type: 'start',
            id: 'review',
            role: 'reviewer',
            task: 'inspect diff',
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
                verdict: 'approved',
                summary: 'okay',
                findings: [],
                validation: [],
                limitations: [],
            },
        },
    });
    await patches.capture(run.id);
    assert.equal(
        completionEligibility((await store.read(run.id)).ledger).eligible,
        true,
    );
    await writeFile(join(workspace, 'README.md'), 'mutated');
    const patch = await patches.capture(run.id);
    const record = await store.read(run.id);
    assert.equal(completionEligibility(record.ledger).eligible, false);
    assert.equal(replayLedger(record.ledger).patch?.diffHash, patch.diffHash);
});

test('stable hashes, revision history, manifest ordering, and mutation invalidation', async (t) => {
    const { patches, workspace, run } = await fixture(t);
    const initial = await patches.latest(run.id);
    await writeFile(join(workspace, 'README.md'), 'changed');
    await writeFile(join(workspace, 'a'), 'a');
    await writeFile(join(workspace, 'b'), 'b');
    const first = await patches.capture(run.id, ['b', 'a']);
    assert.equal(first.sequence, 2);
    assert.notEqual(first.revisionHash, initial?.revisionHash);
    assert.deepEqual(await patches.capture(run.id, ['a', 'b', 'a']), first);
    await writeFile(join(workspace, 'README.md'), 'different');
    assert.equal((await patches.capture(run.id, ['a', 'b'])).sequence, 3);
    await writeFile(join(workspace, 'README.md'), 'changed');
    const restored = await patches.capture(run.id, ['a', 'b']);
    assert.equal(restored.sequence, 4);
    assert.equal(restored.revisionHash, first.revisionHash);
    assert.equal(restored.diffHash, first.diffHash);
});

test('publishes exact binary, modes, deletes and manifested new files, preserving dirty index', async (t) => {
    const { repo, baseline, patches, workspace, run, workspaces, store } =
        await fixture(t, true);
    const binary = Buffer.from([0, 255, 13, 10, 17]);
    await writeFile(join(workspace, 'README.md'), binary);
    await chmod(join(workspace, 'README.md'), 0o755);
    await rm(join(workspace, 'delete-me'));
    await mkdir(join(workspace, 'new dir'));
    await writeFile(join(workspace, 'new dir/file'), binary);
    await symlink('README.md', join(workspace, 'link'));
    await writeFile(join(workspace, 'artifact'), 'not approved');
    await writeFile(join(workspace, 'build.generated'), 'ignored');
    await writeFile(join(workspace, 'user-file'), 'unapproved user file edit');
    const revision = await patches.capture(run.id, ['new dir/file', 'link']);
    await approveAndComplete(workspaces, run.id);
    await patches.publish(run.id, revision.revisionHash);
    assert.deepEqual(await readFile(join(repo.path, 'README.md')), binary);
    assert.equal(
        (await lstat(join(repo.path, 'README.md'))).mode & 0o777,
        0o755,
    );
    assert.deepEqual(await readFile(join(repo.path, 'new dir/file')), binary);
    assert.equal(await readlink(join(repo.path, 'link')), 'README.md');
    for (const name of ['delete-me', 'artifact', 'build.generated'])
        await assert.rejects(lstat(join(repo.path, name)), { code: 'ENOENT' });
    assert.equal(
        await readFile(join(repo.path, 'user-file'), 'utf8'),
        'user data',
    );
    const after = await preflightGitRepository(repo.path, {
        allowDirty: true,
        env: repo.env,
    });
    assert.equal(
        after.index.fingerprint.value,
        baseline.index.fingerprint.value,
    );
    assert.equal((await store.read(run.id)).locations.workspace, null);
});

test('newly staged files still require a manifest; ignored, missing and unsafe manifests fail', async (t) => {
    const { repo, patches, workspace, run, workspaces } = await fixture(t);
    await writeFile(join(workspace, 'staged-new'), 'unapproved');
    await repo.git('-C', workspace, 'add', 'staged-new');
    await writeFile(join(workspace, 'x.generated'), 'ignored');
    for (const path of [
        'x.generated',
        'absent',
        '../escape',
        '/absolute',
        '.git/config',
        'README.md',
    ])
        await assert.rejects(patches.capture(run.id, [path]));
    const revision = await patches.capture(run.id);
    assert.deepEqual(revision.changes, []);
    await approveAndComplete(workspaces, run.id);
    await patches.publish(run.id, revision.revisionHash);
    await assert.rejects(lstat(join(repo.path, 'staged-new')), {
        code: 'ENOENT',
    });
});

for (const change of ['tracked', 'untracked', 'index', 'head'] as const) {
    test(`refuses changed original ${change}`, async (t) => {
        const { repo, patches, workspace, run, workspaces } = await fixture(t);
        await writeFile(join(workspace, 'README.md'), 'agent');
        const revision = await patches.capture(run.id);
        await approveAndComplete(workspaces, run.id);
        if (change === 'tracked') await repo.write('README.md', 'user');
        if (change === 'untracked') await repo.write('user', 'user');
        if (change === 'index') {
            await repo.write('README.md', 'user');
            await repo.git('add', '.');
        }
        if (change === 'head')
            await repo.git('commit', '--allow-empty', '-m', 'concurrent');
        const concurrent = await preflightGitRepository(repo.path, {
            allowDirty: true,
            env: repo.env,
        });
        await assert.rejects(patches.publish(run.id, revision.revisionHash));
        await assertGitFingerprint(concurrent, { env: repo.env });
    });
}

test('stale approval and post-approval mutations cannot publish', async (t) => {
    const { patches, workspace, run, workspaces, baseline, repo } =
        await fixture(t);
    const old = await patches.capture(run.id);
    await writeFile(join(workspace, 'README.md'), 'agent');
    const current = await patches.capture(run.id);
    await approveAndComplete(workspaces, run.id);
    await assert.rejects(patches.publish(run.id, old.revisionHash), /latest/);
    await writeFile(join(workspace, 'README.md'), 'unreviewed');
    await assert.rejects(
        patches.publish(run.id, current.revisionHash),
        /changed since approval/,
    );
    await assertGitFingerprint(baseline, { env: repo.env });
});

test('failure after file writes rolls back bytes, modes, deletes and new directories', async (t) => {
    const { patches, workspace, run, workspaces, baseline, repo, store } =
        await fixture(t, true);
    await writeFile(join(workspace, 'README.md'), 'agent');
    await chmod(join(workspace, 'README.md'), 0o755);
    await rm(join(workspace, 'delete-me'));
    await mkdir(join(workspace, 'nested'));
    await writeFile(join(workspace, 'nested/new'), 'new');
    const revision = await patches.capture(run.id, ['nested/new']);
    await approveAndComplete(workspaces, run.id);
    // Force publication receipt persistence to fail, after every checkout write.
    await mkdir(join(store.runDirectory(run.id), 'patches/published.json'));
    await assert.rejects(patches.publish(run.id, revision.revisionHash));
    await assertGitFingerprint(baseline, { env: repo.env });
    await assert.rejects(lstat(join(repo.path, 'nested')), { code: 'ENOENT' });
    assert.equal((await store.read(run.id)).locations.workspace, workspace);
    await rm(join(store.runDirectory(run.id), 'patches/published.json'), {
        recursive: true,
    });
    await patches.publish(run.id, revision.revisionHash);
});

test('restart recovery restores partial publication and preserves conflicting user edits', async (t) => {
    const { patches, workspace, run, workspaces, baseline, repo, store } =
        await fixture(t);
    await writeFile(join(workspace, 'README.md'), 'agent');
    const revision = await patches.capture(run.id);
    await approveAndComplete(workspaces, run.id);
    const journalPath = join(
        store.runDirectory(run.id),
        'patches/publication-undo.json',
    );
    await writeFile(
        journalPath,
        JSON.stringify({
            version: 1,
            changes: revision.changes,
            directories: [],
        }),
    );
    await repo.write('README.md', 'agent'); // Interrupted after first replacement.
    const restarted = new PatchManager(store, repo.env);
    assert.deepEqual(await restarted.latest(run.id), revision);
    await assert.rejects(
        restarted.publish(run.id, revision.revisionHash),
        /recovery required/,
    );
    await repo.write('README.md', 'concurrent user edit');
    await assert.rejects(restarted.recover(run.id), /Cannot safely restore/);
    assert.equal(
        await readFile(join(repo.path, 'README.md'), 'utf8'),
        'concurrent user edit',
    );
    await lstat(journalPath);
    await repo.write('README.md', 'agent');
    await restarted.recover(run.id);
    await assertGitFingerprint(baseline, { env: repo.env });
    await assert.rejects(lstat(journalPath), { code: 'ENOENT' });
});

test('publication lock refuses competing publishers', async (t) => {
    const { patches, run, workspaces, baseline, repo } = await fixture(t);
    const revision = await patches.capture(run.id);
    await approveAndComplete(workspaces, run.id);
    const lock = join(
        baseline.repository.gitDirectory,
        'flue-publication.lock',
    );
    await mkdir(lock);
    await assert.rejects(patches.publish(run.id, revision.revisionHash), {
        code: 'EEXIST',
    });
    await lstat(lock);
    await assertGitFingerprint(baseline, { env: repo.env });
});

test('ignored original collision and symlink parents are rejected without writes', async (t) => {
    const { patches, workspace, run, workspaces, baseline, repo } =
        await fixture(t);
    await writeFile(join(workspace, 'x.generated'), 'new');
    await writeFile(join(workspace, '.gitignore'), '');
    const revision = await patches.capture(run.id, ['x.generated']);
    await repo.write('x.generated', 'private original');
    await approveAndComplete(workspaces, run.id);
    await assert.rejects(
        patches.publish(run.id, revision.revisionHash),
        /conflict/,
    );
    await assertGitFingerprint(baseline, { env: repo.env });
    await symlink(repo.path, join(workspace, 'escape'));
    await assert.rejects(patches.capture(run.id, ['escape/README.md']));
});
