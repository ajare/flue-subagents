import {
    copyFile,
    chmod,
    lstat,
    mkdir,
    readdir,
    readlink,
    symlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
    assertGitFingerprint,
    gitEnvironment,
    preflightGitRepository,
    runGit,
    type GitPreflightResult,
} from './git-preflight.ts';
import type { RunStore, RunStatus } from './run-storage.ts';
import { lockRun } from './resumption.ts';

export class WorkspaceLimitError extends Error {
    readonly code = 'workspace_limit_exceeded';
    readonly bytes: number;
    readonly limit: number;
    constructor(bytes: number, limit: number) {
        super(`Workspace size ${bytes} bytes exceeds limit ${limit} bytes`);
        this.name = 'WorkspaceLimitError';
        this.bytes = bytes;
        this.limit = limit;
    }
}

/** Logical file bytes, including ignored build output; never follows symlinks. */
export async function workspaceSize(path: string): Promise<number> {
    const entry = await lstat(path);
    if (!entry.isDirectory()) return entry.size;
    let bytes = 0;
    for (const name of await readdir(path)) {
        try {
            bytes += await workspaceSize(join(path, name));
        } catch (error) {
            // Build tools may remove temporary files during a measurement.
            if (
                !(
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'ENOENT'
                )
            )
                throw error;
        }
    }
    return bytes;
}

/** Owns only <run-directory>/workspace. No publication or original-checkout writes. */
export class WorkspaceManager {
    private readonly env: NodeJS.ProcessEnv;
    private readonly exceeded = new Map<string, WorkspaceLimitError>();

    readonly store: RunStore;
    constructor(store: RunStore, env = process.env) {
        this.store = store;
        this.env = gitEnvironment(env);
    }

    async create(id: string, baseline: GitPreflightResult): Promise<string> {
        const run = await this.store.read(id);
        if (run.status !== 'running' || run.locations.workspace !== null) {
            throw new Error('Run already has a workspace or is not running');
        }
        if (
            run.repository.path !== baseline.repository.root ||
            run.repository.device !== baseline.repository.device ||
            run.repository.inode !== baseline.repository.inode
        ) {
            throw new Error('Workspace baseline does not belong to this run');
        }
        await assertGitFingerprint(baseline, { env: this.env });
        const path = join(this.store.runDirectory(id), 'workspace');
        // Persist before provisioning so partial creation remains recoverable.
        await this.store.update(id, { workspace: path });
        await this.git(run.repository.path, [
            '-c',
            'core.hooksPath=/dev/null',
            'worktree',
            'add',
            '--detach',
            path,
            baseline.head,
        ]);
        if (!baseline.clean)
            await this.copyDirtyState(baseline.repository.root, path);
        await assertGitFingerprint(baseline, { env: this.env });
        const copied = await preflightGitRepository(path, {
            allowDirty: true,
            env: this.env,
        });
        if (
            copied.head !== baseline.head ||
            copied.index.fingerprint.value !==
                baseline.index.fingerprint.value ||
            copied.worktree.fingerprint.value !==
                baseline.worktree.fingerprint.value
        ) {
            throw new Error(
                'Workspace does not reproduce the preflight starting state',
            );
        }
        await this.checkLimit(id);
        return path;
    }

    async checkLimit(id: string): Promise<number> {
        const prior = this.exceeded.get(id);
        if (prior) throw prior;
        const run = await this.store.read(id);
        if (!run.locations.workspace) throw new Error('Run has no workspace');
        const bytes = await workspaceSize(run.locations.workspace);
        if (bytes > run.configuration.workspaceLimitBytes) {
            const error = new WorkspaceLimitError(
                bytes,
                run.configuration.workspaceLimitBytes,
            );
            this.exceeded.set(id, error);
            if (run.status === 'running')
                await this.store.update(id, { status: 'blocked' });
            throw error;
        }
        return bytes;
    }

    /** Call only after agents/commands have stopped. Completed is not published. */
    async finish(
        id: string,
        status: Exclude<RunStatus, 'running'>,
    ): Promise<void> {
        const run = await this.store.read(id);
        const outcome = run.status === 'blocked' ? 'blocked' : status;
        if (run.status !== outcome)
            await this.store.update(id, { status: outcome });
        await this.cleanupExpired(id);
    }

    /** Publication's success callback. Never infer publication from model output. */
    async afterPublication(id: string): Promise<void> {
        const run = await this.store.read(id);
        if (run.status !== 'completed')
            throw new Error('Only completed runs can be published');
        await this.remove(id);
    }

    /** Idempotent explicit deletion; refuses arbitrary paths and active runs. */
    async remove(id: string): Promise<void> {
        const run = await this.store.read(id);
        const path = run.locations.workspace;
        if (path === null) return;
        if (run.status === 'running')
            throw new Error('Cannot remove an active workspace');
        if (path !== join(this.store.runDirectory(id), 'workspace')) {
            throw new Error('Refusing to remove an unmanaged workspace');
        }
        const listing = (
            await this.git(run.repository.path, [
                'worktree',
                'list',
                '--porcelain',
                '-z',
            ])
        ).toString();
        if (listing.split('\0').includes(`worktree ${path}`)) {
            await this.git(run.repository.path, [
                'worktree',
                'remove',
                '--force',
                path,
            ]);
        } else {
            // A failed add may never have created a directory. Do not recursively
            // delete an unregistered directory just because its name matches.
            try {
                await lstat(path);
                throw new Error('Refusing to remove an unregistered workspace');
            } catch (error) {
                if (
                    !(
                        error instanceof Error &&
                        'code' in error &&
                        error.code === 'ENOENT'
                    )
                )
                    throw error;
            }
        }
        await this.store.update(id, { workspace: null });
    }

    async cleanupExpired(id: string, now = Date.now()): Promise<boolean> {
        const run = await this.store.read(id);
        if (
            !run.locations.workspace ||
            run.status === 'running' ||
            run.status === 'completed'
        )
            return false;
        const stoppedAt = Date.parse(
            run.timestamps.completedAt ?? run.timestamps.updatedAt,
        );
        if (now < stoppedAt + run.configuration.retentionMs) return false;
        await this.remove(id);
        return true;
    }

    /** Opportunistic sweep on startup; never deletes running or unpublished work. */
    async sweep(now = Date.now()): Promise<void> {
        let ids: string[];
        try {
            ids = (
                await readdir(this.store.runsDirectory, { withFileTypes: true })
            )
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
        } catch (error) {
            if (
                error instanceof Error &&
                'code' in error &&
                error.code === 'ENOENT'
            )
                return;
            throw error;
        }
        for (const id of ids) {
            let unlock: (() => Promise<void>) | undefined;
            try {
                unlock = await lockRun(this.store, id);
                await this.cleanupExpired(id, now);
            } catch (error) {
                if (
                    !(
                        error instanceof Error &&
                        'code' in error &&
                        error.code === 'EEXIST'
                    )
                )
                    throw error;
            } finally {
                await unlock?.();
            }
        }
    }

    private async copyDirtyState(
        source: string,
        destination: string,
    ): Promise<void> {
        const flags = [
            '--binary',
            '--full-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
        ];
        const staged = await this.git(source, [
            'diff',
            '--cached',
            ...flags,
            '--',
        ]);
        if (staged.length)
            await this.git(
                destination,
                ['apply', '--index', '--binary', '--whitespace=nowarn', '-'],
                staged,
            );
        const unstaged = await this.git(source, ['diff', ...flags, '--']);
        if (unstaged.length)
            await this.git(
                destination,
                ['apply', '--binary', '--whitespace=nowarn', '-'],
                unstaged,
            );
        const untracked = await this.git(source, [
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
        ]);
        for (const name of untracked.toString().split('\0').filter(Boolean)) {
            const from = join(source, name);
            const to = join(destination, name);
            const entry = await lstat(from);
            await mkdir(dirname(to), { recursive: true });
            if (entry.isSymbolicLink()) await symlink(await readlink(from), to);
            else if (entry.isFile()) {
                await copyFile(from, to);
                await chmod(to, entry.mode & 0o777);
            } else throw new Error(`Unsupported untracked file: ${name}`);
        }
    }

    private async git(
        cwd: string,
        args: string[],
        input?: Buffer,
    ): Promise<Buffer> {
        return (await runGit({ cwd, env: this.env }, args, { input })).stdout;
    }
}
