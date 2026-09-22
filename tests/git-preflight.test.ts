import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    GitPreflightError,
    assertGitFingerprint,
    preflightGitRepository,
} from '../src/git-preflight.ts';
import { createGitFixture } from './helpers/git.ts';

test('clean repositories receive a stable identity and fingerprint', async (t) => {
    const fixture = await createGitFixture(t);
    const first = await preflightGitRepository(fixture.path, {
        env: fixture.env,
    });
    const second = await preflightGitRepository(fixture.path, {
        env: fixture.env,
    });

    assert.equal(first.repository.root, fixture.path);
    assert.ok(first.repository.device >= 0);
    assert.ok(first.repository.inode > 0);
    assert.match(first.head, /^[0-9a-f]{40,64}$/u);
    assert.equal(first.branch, 'main');
    assert.equal(first.clean, true);
    assert.equal(first.index.dirty, false);
    assert.equal(first.worktree.dirty, false);
    assert.deepEqual(first.fingerprint, second.fingerprint);
    await assert.doesNotReject(
        assertGitFingerprint(first, { env: fixture.env }),
    );
});

test('dirty state requires permission and every allowed state is fingerprinted', async (t) => {
    const fixture = await createGitFixture(t);
    await fixture.write('README.md', '# changed\n');
    await fixture.write('untracked.txt', 'one\n');

    await assert.rejects(
        preflightGitRepository(fixture.path, { env: fixture.env }),
        (error: unknown) =>
            error instanceof GitPreflightError &&
            error.code === 'dirty_repository',
    );

    const initial = await preflightGitRepository(fixture.path, {
        allowDirty: true,
        env: fixture.env,
    });
    assert.equal(initial.clean, false);
    assert.equal(initial.worktree.dirty, true);
    assert.equal(initial.worktree.untracked, true);

    await fixture.write('untracked.txt', 'two\n');
    const changedUntracked = await preflightGitRepository(fixture.path, {
        allowDirty: true,
        env: fixture.env,
    });
    assert.notEqual(
        changedUntracked.fingerprint.value,
        initial.fingerprint.value,
    );
    await assert.rejects(
        assertGitFingerprint(initial, { env: fixture.env }),
        (error: unknown) =>
            error instanceof GitPreflightError &&
            error.code === 'repository_changed',
    );

    await fixture.git('add', 'README.md');
    const staged = await preflightGitRepository(fixture.path, {
        allowDirty: true,
        env: fixture.env,
    });
    assert.equal(staged.index.dirty, true);
    assert.notEqual(
        staged.index.fingerprint.value,
        initial.index.fingerprint.value,
    );
});

test('non-repositories and unsafe in-progress operations are rejected', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'flue-not-git-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await assert.rejects(
        preflightGitRepository(directory),
        (error: unknown) =>
            error instanceof GitPreflightError &&
            error.code === 'not_git_repository',
    );

    const fixture = await createGitFixture(t);
    await writeFile(
        join(fixture.path, '.git', 'MERGE_HEAD'),
        `${await fixture.git('rev-parse', 'HEAD')}\n`,
    );
    await assert.rejects(
        preflightGitRepository(fixture.path, {
            allowDirty: true,
            env: fixture.env,
        }),
        (error: unknown) =>
            error instanceof GitPreflightError &&
            error.code === 'unsupported_repository_state',
    );
});
