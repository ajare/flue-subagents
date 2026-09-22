import { createHash, randomUUID } from 'node:crypto';
import {
    chmod,
    lstat,
    mkdir,
    readFile,
    readlink,
    rename,
    rm,
    rmdir,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
    assertGitFingerprint,
    gitEnvironment,
    preflightGitRepository,
    runGit,
    type GitPreflightResult,
} from './git-preflight.ts';
import type { RunStore } from './run-storage.ts';
import { completionEligibility } from './delegation-ledger.ts';
import { WorkspaceManager } from './workspaces.ts';

/** Raw bytes, not Git-filtered blobs: publication must reproduce reviewed content. */
interface FileImage {
    kind: 'file' | 'symlink';
    mode: number;
    data: string;
}
type Snapshot = Record<string, FileImage | null>;
export interface PatchChange {
    path: string;
    before: FileImage | null;
    after: FileImage | null;
}
export interface PatchRevision {
    version: 1;
    sequence: number;
    workspaceHash: string;
    diffHash: string;
    patchHash: string;
    revisionHash: string;
    approvedNewFiles: string[];
    changes: PatchChange[];
}
interface Baseline {
    git: GitPreflightResult;
    files: Snapshot;
    tracked: string[];
}
interface Journal {
    version: 1;
    changes: PatchChange[];
    directories: string[];
}

/** Serialized per run. Call capture only at mutation boundaries, after commands settle. */
export class PatchManager {
    private readonly env: NodeJS.ProcessEnv;
    private readonly workspaces: WorkspaceManager;
    private readonly pending = new Map<string, Promise<unknown>>();
    private readonly store: RunStore;
    constructor(store: RunStore, env = process.env) {
        this.store = store;
        this.env = gitEnvironment(env);
        this.workspaces = new WorkspaceManager(store, env);
    }

    async initialize(id: string, git: GitPreflightResult): Promise<void> {
        const run = await this.store.read(id);
        if (
            run.repository.path !== git.repository.root ||
            !run.locations.workspace
        )
            throw new Error('Patch baseline does not belong to workspace');
        await assertGitFingerprint(git, { env: this.env });
        const tracked = await this.names(git.repository.root, [
            'ls-files',
            '-z',
        ]);
        const files = await this.snapshot(git.repository.root, tracked);
        await assertGitFingerprint(git, { env: this.env });
        const copied = await this.snapshot(run.locations.workspace, tracked);
        if (hash(files) !== hash(copied))
            throw new Error('Workspace baseline differs');
        await mkdir(this.directory(id), { recursive: true });
        await writeFile(
            join(this.directory(id), 'baseline.json'),
            JSON.stringify({ git, files, tracked }),
            { flag: 'wx', mode: 0o600 },
        );
        await this.capture(id);
    }

    capture(
        id: string,
        approvedNewFiles: readonly string[] = [],
    ): Promise<PatchRevision> {
        return this.serial(id, async () => {
            const revision = await this.calculate(id, approvedNewFiles);
            const latest = await this.latest(id);
            if (latest?.revisionHash === revision.revisionHash) {
                await this.recordRevision(id, latest);
                return latest;
            }
            revision.sequence = (latest?.sequence ?? 0) + 1;
            await atomicJson(
                join(this.directory(id), `revision-${revision.sequence}.json`),
                revision,
            );
            await atomicJson(join(this.directory(id), 'latest.json'), revision);
            await this.recordRevision(id, revision);
            return revision;
        });
    }

    private async recordRevision(
        id: string,
        revision: PatchRevision,
    ): Promise<void> {
        await this.store.update(id, {
            ledgerAction: {
                type: 'patch',
                patch: {
                    revisionHash: revision.revisionHash,
                    diffHash: revision.diffHash,
                },
            },
        });
    }

    async latest(id: string): Promise<PatchRevision | null> {
        return await json<PatchRevision>(
            join(this.directory(id), 'latest.json'),
        ).catch((error: unknown) => {
            if (missing(error)) return null;
            throw error;
        });
    }

    /** Explicit approval is the exact latest revision hash, never an agent's text. */
    publish(id: string, approvedRevisionHash: string): Promise<void> {
        return this.serial(id, async () => {
            const run = await this.store.read(id);
            if (run.status !== 'completed')
                throw new Error('Only completed runs can publish');
            const approval = completionEligibility(run.ledger);
            if (!approval.eligible)
                throw new Error(
                    `Publication requires independent review: ${approval.reasons.join('; ')}`,
                );
            await this.workspaces.checkLimit(id);
            const baseline = await this.baseline(id);
            const root = baseline.git.repository.root;
            const lock = join(
                baseline.git.repository.gitDirectory,
                'flue-publication.lock',
            );
            await mkdir(lock); // Cooperating publishers, including other runs, are excluded.
            try {
                if (await exists(this.journalPath(id)))
                    throw new Error('Publication recovery required');
                const approved = await this.latest(id);
                if (!approved || approved.revisionHash !== approvedRevisionHash)
                    throw new Error('Approval is not for the latest revision');
                const current = await this.calculate(
                    id,
                    approved.approvedNewFiles,
                );
                if (current.revisionHash !== approvedRevisionHash)
                    throw new Error('Workspace changed since approval');
                await assertGitFingerprint(baseline.git, { env: this.env });
                // Also checks raw bytes (including tracked files hidden by index flags).
                const original = await this.snapshot(root, baseline.tracked);
                if (hash(original) !== hash(baseline.files))
                    throw new Error('Original repository changed');
                const directories = new Set<string>();
                for (const change of current.changes) {
                    await parents(root, change.path, directories);
                    if (!equal(await image(root, change.path), change.before))
                        throw new Error(`Publication conflict: ${change.path}`);
                }
                const journal: Journal = {
                    version: 1,
                    changes: current.changes,
                    directories: [...directories].sort(
                        (a, b) => a.length - b.length,
                    ),
                };
                // Retain the undo record on disk until all writes and checks succeed.
                await atomicJson(this.journalPath(id), journal);
                try {
                    await assertGitFingerprint(baseline.git, { env: this.env });
                    for (const directory of journal.directories)
                        await mkdir(join(root, directory));
                    for (const change of journal.changes) {
                        await parents(root, change.path);
                        if (
                            !equal(
                                await image(root, change.path),
                                change.before,
                            )
                        )
                            throw new Error(`Concurrent edit: ${change.path}`);
                        await put(root, change.path, change.after);
                    }
                    const expected = { ...baseline.files };
                    for (const change of journal.changes) {
                        if (
                            change.after === null &&
                            !baseline.tracked.includes(change.path)
                        )
                            delete expected[change.path];
                        else expected[change.path] = change.after;
                    }
                    if (
                        hash(await this.snapshot(root, baseline.tracked)) !==
                        hash(sortSnapshot(expected))
                    )
                        throw new Error(
                            'Concurrent repository change during publication',
                        );
                    const state = await preflightGitRepository(root, {
                        allowDirty: true,
                        env: this.env,
                    });
                    if (
                        state.head !== baseline.git.head ||
                        state.branch !== baseline.git.branch ||
                        state.index.fingerprint.value !==
                            baseline.git.index.fingerprint.value
                    )
                        throw new Error(
                            'Concurrent Git change during publication',
                        );
                    await atomicJson(
                        join(this.directory(id), 'published.json'),
                        current,
                    );
                } catch (error) {
                    await this.rollback(root, journal);
                    await rm(this.journalPath(id));
                    throw error;
                }
                await rm(this.journalPath(id));
            } finally {
                await rmdir(lock);
            }
            await this.workspaces.afterPublication(id);
        });
    }

    /** Explicit undo after interruption. Stop writers first; remove a stale lock only after checking its owner is dead. */
    recover(id: string): Promise<void> {
        return this.serial(id, async () => {
            const baseline = await this.baseline(id);
            const lock = join(
                baseline.git.repository.gitDirectory,
                'flue-publication.lock',
            );
            await mkdir(lock);
            try {
                const journal = await json<Journal>(this.journalPath(id));
                await this.rollback(baseline.git.repository.root, journal);
                await rm(this.journalPath(id));
                await rm(join(this.directory(id), 'published.json'), {
                    force: true,
                });
            } finally {
                await rmdir(lock);
            }
        });
    }

    private async rollback(root: string, journal: Journal): Promise<void> {
        // Do not overwrite a third party's edit. Leave journal intact for manual recovery.
        for (const change of journal.changes) {
            const value = await image(root, change.path);
            if (!equal(value, change.before) && !equal(value, change.after))
                throw new Error(
                    `Cannot safely restore concurrent edit: ${change.path}; recovery journal retained`,
                );
        }
        for (const change of [...journal.changes].reverse()) {
            await parents(root, change.path);
            if (!equal(await image(root, change.path), change.before))
                await put(root, change.path, change.before);
        }
        for (const directory of [...journal.directories].reverse()) {
            await rmdir(join(root, directory)).catch((error: unknown) => {
                if (
                    !missing(error) &&
                    !(
                        error instanceof Error &&
                        'code' in error &&
                        error.code === 'ENOTEMPTY'
                    )
                )
                    throw error;
            });
        }
    }

    private async calculate(
        id: string,
        manifest: readonly string[],
    ): Promise<PatchRevision> {
        const baseline = await this.baseline(id);
        const run = await this.store.read(id);
        const workspace = run.locations.workspace;
        if (!workspace) throw new Error('Run has no workspace');
        const approvedNewFiles = [...new Set(manifest)].sort();
        const files = await this.snapshot(workspace, baseline.tracked);
        for (const path of approvedNewFiles) {
            validatePath(path);
            if (baseline.tracked.includes(path))
                throw new Error(`Manifest path is already tracked: ${path}`);
            const ignored = await runGit(
                { cwd: workspace, env: this.env },
                ['check-ignore', '--no-index', '-q', '--', path],
                { allowedExitCodes: [0, 1] },
            );
            if (ignored.code === 0 || !files[path])
                throw new Error(`Manifest path is missing or ignored: ${path}`);
        }
        const changes: PatchChange[] = [];
        for (const path of [
            ...new Set([...baseline.tracked, ...approvedNewFiles]),
        ].sort()) {
            const before = baseline.files[path] ?? null;
            const after = files[path] ?? null;
            if (!equal(before, after)) changes.push({ path, before, after });
        }
        const workspaceHash = hash(files);
        const diffHash = hash(changes);
        const patchHash = hash({ version: 1, diffHash, approvedNewFiles });
        const revisionHash = hash({ workspaceHash, patchHash });
        return {
            version: 1,
            sequence: 0,
            workspaceHash,
            diffHash,
            patchHash,
            revisionHash,
            approvedNewFiles,
            changes,
        };
    }

    private async snapshot(root: string, tracked: string[]): Promise<Snapshot> {
        const names = await this.names(root, [
            'ls-files',
            '--cached',
            '--others',
            '--exclude-standard',
            '-z',
        ]);
        const result: Snapshot = Object.create(null) as Snapshot;
        for (const path of [...new Set([...tracked, ...names])].sort()) {
            validatePath(path);
            result[path] = await image(root, path);
        }
        return result;
    }
    private async names(root: string, args: string[]): Promise<string[]> {
        const { stdout } = await runGit({ cwd: root, env: this.env }, args);
        if (!Buffer.from(stdout.toString()).equals(stdout))
            throw new Error('Non-UTF-8 paths are unsupported');
        return stdout.toString().split('\0').filter(Boolean);
    }
    private baseline(id: string): Promise<Baseline> {
        return json(join(this.directory(id), 'baseline.json'));
    }
    private directory(id: string): string {
        return join(this.store.runDirectory(id), 'patches');
    }
    private journalPath(id: string): string {
        return join(this.directory(id), 'publication-undo.json');
    }
    private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
        const next = (this.pending.get(id) ?? Promise.resolve())
            .catch(() => {})
            .then(operation);
        this.pending.set(id, next);
        return next;
    }
}

function validatePath(path: string): void {
    if (
        !path ||
        path.includes('\\') ||
        path.includes('\0') ||
        path
            .split('/')
            .some(
                (part) =>
                    !part ||
                    part === '.' ||
                    part === '..' ||
                    part.toLowerCase() === '.git',
            )
    )
        throw new Error(`Unsafe patch path: ${path}`);
}
async function parents(
    root: string,
    path: string,
    missingDirectories?: Set<string>,
): Promise<void> {
    validatePath(path);
    const parts = path.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
        const relative = parts.slice(0, i).join('/');
        const entry = await lstat(join(root, relative)).catch(
            (error: unknown) => {
                if (missing(error)) return null;
                throw error;
            },
        );
        if (!entry) missingDirectories?.add(relative);
        else if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error(`Unsafe patch parent: ${relative}`);
    }
}
async function image(root: string, path: string): Promise<FileImage | null> {
    await parents(root, path);
    const absolute = join(root, path);
    try {
        const entry = await lstat(absolute);
        if (entry.isSymbolicLink())
            return {
                kind: 'symlink',
                mode: 0o777,
                data: (
                    await readlink(absolute, { encoding: 'buffer' })
                ).toString('base64'),
            };
        if (!entry.isFile()) throw new Error(`Unsupported patch file: ${path}`);
        return {
            kind: 'file',
            mode: entry.mode & 0o777,
            data: (await readFile(absolute)).toString('base64'),
        };
    } catch (error) {
        if (missing(error)) return null;
        throw error;
    }
}
async function put(
    root: string,
    path: string,
    value: FileImage | null,
): Promise<void> {
    const target = join(root, path);
    if (!value) {
        await rm(target, { force: true });
        return;
    }
    const temporary = join(dirname(target), `.flue-${randomUUID()}`);
    try {
        if (value.kind === 'symlink')
            await symlink(Buffer.from(value.data, 'base64'), temporary);
        else {
            await writeFile(temporary, Buffer.from(value.data, 'base64'), {
                flag: 'wx',
                mode: value.mode,
            });
            await chmod(temporary, value.mode);
        }
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(value), {
            flag: 'wx',
            mode: 0o600,
        });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}
async function json<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, 'utf8')) as T;
}
function hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function equal(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
function sortSnapshot(files: Snapshot): Snapshot {
    return Object.fromEntries(
        Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
}
function missing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (missing(error)) return false;
        throw error;
    }
}
