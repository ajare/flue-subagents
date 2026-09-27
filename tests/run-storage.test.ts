import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { DEFAULT_CONFIGURATION } from '../src/config.ts';
import { WorkspaceManager } from '../src/workspaces.ts';
import {
    RunStorageError,
    RunStore,
    userDataDirectory,
} from '../src/run-storage.ts';

async function directories(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'flue-storage-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, 'repository');
    const storage = join(root, 'state');
    await mkdir(repository);
    return { root, repository, storage };
}

test('run records survive a new store instance with repository identity', async (t) => {
    const paths = await directories(t);
    const store = new RunStore({
        root: paths.storage,
        generateId: () => 'stable-run-id',
        now: () => new Date('2025-01-01T00:00:00.000Z'),
    });
    const created = await store.create({
        repository: paths.repository,
        configuration: DEFAULT_CONFIGURATION,
        conversationId: 'conversation-1',
    });

    const loaded = await new RunStore({ root: paths.storage }).read(created.id);
    assert.equal(loaded.id, 'stable-run-id');
    assert.equal(loaded.status, 'running');
    assert.equal(loaded.conversationId, 'conversation-1');
    assert.equal(loaded.repository.path, paths.repository);
    assert.ok(loaded.repository.inode > 0);
    assert.equal(loaded.locations.workspace, null);
    assert.equal(
        loaded.locations.auditLog,
        join(paths.storage, 'runs', created.id, 'audit.ndjson'),
    );
    assert.equal(created.configuration.model, DEFAULT_CONFIGURATION.model);
});

test('legacy run snapshots without presentation limits remain readable', async (t) => {
    const paths = await directories(t);
    const store = new RunStore({ root: paths.storage });
    const run = await store.create({
        repository: paths.repository,
        configuration: DEFAULT_CONFIGURATION,
    });
    const snapshot = JSON.parse(await readFile(store.recordPath(run.id), 'utf8'));
    for (const key of ['resultMaxStringLength', 'resultMaxCollectionItems', 'resultMaxLength'])
        delete snapshot.configuration[key];
    await writeFile(store.recordPath(run.id), JSON.stringify(snapshot));
    // A new CLI execution sweeps historical runs before creating its own run.
    await new WorkspaceManager(store).sweep();
    const loaded = await store.read(run.id);
    assert.equal(loaded.id, run.id);
    for (const key of ['resultMaxStringLength', 'resultMaxCollectionItems', 'resultMaxLength'] as const)
        assert.equal(loaded.configuration[key], DEFAULT_CONFIGURATION[key]);
    await store.update(run.id, { status: 'completed' });
    const persisted = JSON.parse(await readFile(store.recordPath(run.id), 'utf8'));
    assert.equal(persisted.configuration.resultMaxStringLength, DEFAULT_CONFIGURATION.resultMaxStringLength);
});

test('presentation limits preserve overrides and reject invalid saved values', async (t) => {
    const paths = await directories(t);
    const store = new RunStore({ root: paths.storage });
    const run = await store.create({ repository: paths.repository, configuration: DEFAULT_CONFIGURATION });
    const snapshot = JSON.parse(await readFile(store.recordPath(run.id), 'utf8'));
    for (const key of ['resultMaxStringLength', 'resultMaxCollectionItems', 'resultMaxLength']) {
        for (const invalid of [null, 0, -1, 1.5, '4000']) {
            const configuration = { ...snapshot.configuration, [key]: invalid };
            await writeFile(store.recordPath(run.id), JSON.stringify({ ...snapshot, configuration }));
            await assert.rejects(store.read(run.id), /must be a positive integer/);
        }
        const configuration = { ...snapshot.configuration, [key]: 123 };
        await writeFile(store.recordPath(run.id), JSON.stringify({ ...snapshot, configuration }));
        assert.equal((await store.read(run.id)).configuration[key as keyof typeof DEFAULT_CONFIGURATION], 123);
    }
});

test('updates are atomic and status transitions are validated', async (t) => {
    const paths = await directories(t);
    let tick = 0;
    const store = new RunStore({
        root: paths.storage,
        generateId: () => 'run-1',
        now: () => new Date(Date.UTC(2025, 0, 1, 0, 0, tick++)),
    });
    await store.create({
        repository: paths.repository,
        configuration: DEFAULT_CONFIGURATION,
    });
    const completed = await store.update('run-1', { status: 'completed' });
    assert.equal(completed.revision, 1);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.timestamps.completedAt);

    await assert.rejects(
        store.update('run-1', { status: 'running' }),
        (error: unknown) =>
            error instanceof RunStorageError &&
            error.code === 'invalid_status_transition',
    );
    const source = await readFile(store.recordPath('run-1'), 'utf8');
    assert.equal(JSON.parse(source).status, 'completed');
});

test('invalid and partially written records fail closed', async (t) => {
    const paths = await directories(t);
    const store = new RunStore({
        root: paths.storage,
        generateId: () => 'broken-run',
    });
    await store.create({
        repository: paths.repository,
        configuration: DEFAULT_CONFIGURATION,
    });
    await writeFile(store.recordPath('broken-run'), '{"status":', 'utf8');

    await assert.rejects(
        store.read('broken-run'),
        (error: unknown) =>
            error instanceof RunStorageError &&
            error.code === 'invalid_run_record',
    );
});

test('storage inside the target repository is refused', async (t) => {
    const paths = await directories(t);
    const store = new RunStore({
        root: join(paths.repository, '.state'),
        generateId: () => 'unsafe-run',
    });
    await assert.rejects(
        store.create({
            repository: paths.repository,
            configuration: DEFAULT_CONFIGURATION,
        }),
        (error: unknown) =>
            error instanceof RunStorageError &&
            error.code === 'unsafe_storage_location',
    );
});

test('user data directory follows platform conventions and supports override', () => {
    assert.equal(
        userDataDirectory({ FLUE_AGENT_DATA_DIR: '/custom/state' }, 'linux'),
        '/custom/state',
    );
    assert.equal(
        userDataDirectory({ XDG_DATA_HOME: '/xdg' }, 'linux'),
        '/xdg/flue-agent',
    );
    assert.equal(
        userDataDirectory({ HOME: '/Users/test' }, 'darwin'),
        '/Users/test/Library/Application Support/flue-agent',
    );
});
