import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import {
    CommitManager,
    commitRequestFromPrompt,
} from '../src/commit-handling.ts';
import { DEFAULT_CONFIGURATION } from '../src/config.ts';
import { preflightGitRepository } from '../src/git-preflight.ts';
import { PatchManager } from '../src/patch-publication.ts';
import { RunStore } from '../src/run-storage.ts';
import { WorkspaceManager } from '../src/workspaces.ts';
import { createGitFixture } from './helpers/git.ts';

async function prepared(t: TestContext) {
    const repo = await createGitFixture(t);
    const baseline = await preflightGitRepository(repo.path, { env: repo.env });
    const store = new RunStore({
        root: join(dirname(repo.path), 'commit-data'),
    });
    const run = await store.create({
        repository: repo.path,
        configuration: DEFAULT_CONFIGURATION,
    });
    const workspaces = new WorkspaceManager(store, repo.env);
    const workspace = await workspaces.create(run.id, baseline);
    const patches = new PatchManager(store, repo.env);
    await patches.initialize(run.id, baseline);
    await writeFile(join(workspace, 'README.md'), 'approved\n');
    const revision = await patches.capture(run.id);
    await store.update(run.id, {
        ledgerAction: {
            type: 'start',
            id: 'review',
            role: 'reviewer',
            task: 'review final patch',
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
                summary: 'approved',
                findings: [],
                validation: [],
                limitations: [],
            },
        },
    });
    await workspaces.finish(run.id, 'completed');
    return { repo, store, run, patches, revision, baseline };
}

test('commit intent requires a direct, non-negated request and extracts a message', () => {
    assert.deepEqual(commitRequestFromPrompt('Implement commit handling'), {
        requested: false,
    });
    assert.deepEqual(commitRequestFromPrompt("Make changes but don't commit"), {
        requested: false,
    });
    assert.deepEqual(
        commitRequestFromPrompt(
            'Commit the changes with message "fix: exact patch"',
        ),
        { requested: true, message: 'fix: exact patch' },
    );
    assert.deepEqual(commitRequestFromPrompt('implement it', true), {
        requested: true,
    });
});

test('default finalization publishes without creating a commit', async (t) => {
    const { repo, store, run, patches, revision, baseline } = await prepared(t);
    const result = await new CommitManager(store, repo.env, patches).finalize(
        run.id,
        revision.revisionHash,
    );
    assert.deepEqual(result, { status: 'published', commit: null });
    assert.equal(await repo.git('rev-parse', 'HEAD'), baseline.head);
    assert.equal(
        await readFile(join(repo.path, 'README.md'), 'utf8'),
        'approved\n',
    );
});

test('explicit request commits only the approved patch with supplied message', async (t) => {
    const { repo, store, run, patches, revision, baseline } = await prepared(t);
    const result = await new CommitManager(store, repo.env, patches).finalize(
        run.id,
        revision.revisionHash,
        { requested: true, message: 'fix: approved output' },
    );
    assert.equal(result.status, 'committed');
    assert.notEqual(await repo.git('rev-parse', 'HEAD'), baseline.head);
    assert.equal(
        await repo.git('show', '-s', '--format=%s'),
        'fix: approved output',
    );
    assert.equal(
        await repo.git('diff', 'HEAD^', 'HEAD', '--name-only'),
        'README.md',
    );
    assert.equal(await repo.git('status', '--porcelain'), '');
});

test('hook rejection is blocked without bypassing hooks or changing HEAD', async (t) => {
    const { repo, store, run, patches, revision, baseline } = await prepared(t);
    const hooks = join(dirname(repo.path), 'reject-hooks');
    await mkdir(hooks);
    const hook = join(hooks, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho rejected >&2\nexit 1\n');
    await chmod(hook, 0o755);
    await repo.git('config', 'core.hooksPath', hooks);
    const result = await new CommitManager(store, repo.env, patches).finalize(
        run.id,
        revision.revisionHash,
        { requested: true },
    );
    assert.equal(result.status, 'blocked');
    assert.match(result.status === 'blocked' ? result.reason : '', /rejected/u);
    assert.equal(await repo.git('rev-parse', 'HEAD'), baseline.head);
});

test('hook mutation cannot produce an unreviewed successful commit', async (t) => {
    const { repo, store, run, patches, revision, baseline } = await prepared(t);
    const hooks = join(dirname(repo.path), 'mutating-hooks');
    await mkdir(hooks);
    const hook = join(hooks, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nprintf hook-mutated > README.md\n');
    await chmod(hook, 0o755);
    await repo.git('config', 'core.hooksPath', hooks);
    const result = await new CommitManager(store, repo.env, patches).finalize(
        run.id,
        revision.revisionHash,
        { requested: true },
    );
    assert.equal(result.status, 'blocked');
    assert.equal(await repo.git('rev-parse', 'HEAD'), baseline.head);
});
