import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export const GIT_FINGERPRINT_VERSION = 1;

export interface GitStateFingerprint {
    algorithm: 'sha256';
    value: string;
}

export interface GitPreflightResult {
    repository: {
        /** Canonical Git worktree root. */
        root: string;
        gitDirectory: string;
        commonDirectory: string;
        device: number;
        inode: number;
    };
    head: string;
    /** Null when HEAD is detached. */
    branch: string | null;
    detached: boolean;
    clean: boolean;
    index: {
        dirty: boolean;
        fingerprint: GitStateFingerprint;
    };
    worktree: {
        dirty: boolean;
        untracked: boolean;
        fingerprint: GitStateFingerprint;
    };
    fingerprint: GitStateFingerprint;
}

export type GitPreflightErrorCode =
    | 'not_git_repository'
    | 'dirty_repository'
    | 'unsupported_repository_state'
    | 'git_command_failed'
    | 'repository_changed';

export class GitPreflightError extends Error {
    readonly code: GitPreflightErrorCode;

    constructor(
        code: GitPreflightErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'GitPreflightError';
        this.code = code;
    }
}

export interface GitPreflightOptions {
    allowDirty?: boolean;
    env?: NodeJS.ProcessEnv;
}

/**
 * Inspect a worktree without modifying it and produce a content-sensitive,
 * reproducible fingerprint of HEAD, the index, and all non-ignored changes.
 */
export async function preflightGitRepository(
    path: string,
    options: GitPreflightOptions = {},
): Promise<GitPreflightResult> {
    const env = gitEnvironment(options.env ?? process.env);
    const requestedPath = resolve(path);
    const context = { cwd: requestedPath, env };

    let root: string;
    try {
        const bare = await gitText(context, [
            'rev-parse',
            '--is-bare-repository',
        ]);
        if (bare === 'true') {
            throw unsupported('Bare repositories are not supported');
        }
        root = await gitText(context, ['rev-parse', '--show-toplevel']);
    } catch (error) {
        if (
            error instanceof GitPreflightError &&
            error.code === 'unsupported_repository_state'
        ) {
            throw error;
        }
        throw new GitPreflightError(
            'not_git_repository',
            `Not a Git repository: ${requestedPath}`,
            { cause: error },
        );
    }

    const rootStat = await stat(root);
    const repository = {
        root,
        gitDirectory: absoluteGitPath(
            root,
            await gitText({ cwd: root, env }, [
                'rev-parse',
                '--absolute-git-dir',
            ]),
        ),
        commonDirectory: absoluteGitPath(
            root,
            await gitText({ cwd: root, env }, [
                'rev-parse',
                '--git-common-dir',
            ]),
        ),
        device: rootStat.dev,
        inode: rootStat.ino,
    };
    const git = { cwd: repository.root, env };

    const head = await requiredHead(git);
    const branchOutput = await runGit(
        git,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        {
            allowedExitCodes: [0, 1],
        },
    );
    const branch =
        branchOutput.code === 0 ? decodeLine(branchOutput.stdout) : null;

    await assertSupportedState(git, repository);

    const statusBefore = await gitBuffer(git, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
    ]);
    const status = parseStatus(statusBefore);
    const clean = !status.indexDirty && !status.worktreeDirty;
    if (!clean && !options.allowDirty) {
        throw new GitPreflightError(
            'dirty_repository',
            'Repository has staged, unstaged, or untracked changes; rerun with --allow-dirty to use this exact starting state',
        );
    }

    const indexFingerprint = await hashGitOutput(
        git,
        ['ls-files', '--stage', '-z'],
        'flue-git-index-v1',
    );
    const worktreeFingerprint = await fingerprintWorktree(git, statusBefore);

    // Catch changes made while potentially large files were being fingerprinted.
    const statusAfter = await gitBuffer(git, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
    ]);
    if (!statusBefore.equals(statusAfter)) {
        throw new GitPreflightError(
            'repository_changed',
            'Repository changed while Git preflight was running',
        );
    }

    const fingerprint = digestFields('flue-git-repository-v1', [
        repository.root,
        repository.gitDirectory,
        repository.commonDirectory,
        String(repository.device),
        String(repository.inode),
        head,
        branch ?? '',
        indexFingerprint.value,
        worktreeFingerprint.value,
    ]);

    return Object.freeze({
        repository: Object.freeze(repository),
        head,
        branch,
        detached: branch === null,
        clean,
        index: Object.freeze({
            dirty: status.indexDirty,
            fingerprint: indexFingerprint,
        }),
        worktree: Object.freeze({
            dirty: status.worktreeDirty,
            untracked: status.untracked,
            fingerprint: worktreeFingerprint,
        }),
        fingerprint,
    });
}

/** Re-run preflight and fail if any publish-relevant starting state changed. */
export async function assertGitFingerprint(
    expected: GitPreflightResult,
    options: Pick<GitPreflightOptions, 'env'> = {},
): Promise<GitPreflightResult> {
    const current = await preflightGitRepository(expected.repository.root, {
        allowDirty: true,
        env: options.env,
    });
    if (current.fingerprint.value !== expected.fingerprint.value) {
        throw new GitPreflightError(
            'repository_changed',
            'Repository state no longer matches its preflight fingerprint',
        );
    }
    return current;
}

interface GitContext {
    cwd: string;
    env: NodeJS.ProcessEnv;
}

interface GitResult {
    code: number;
    stdout: Buffer;
    stderr: Buffer;
}

async function requiredHead(git: GitContext): Promise<string> {
    const result = await runGit(git, ['rev-parse', '--verify', 'HEAD'], {
        allowedExitCodes: [0, 128],
    });
    if (result.code !== 0) {
        throw unsupported(
            'Repositories without an initial commit are not supported',
        );
    }
    return decodeLine(result.stdout);
}

async function assertSupportedState(
    git: GitContext,
    repository: GitPreflightResult['repository'],
): Promise<void> {
    const unmerged = await gitBuffer(git, ['ls-files', '--unmerged', '-z']);
    if (unmerged.length > 0) {
        throw unsupported(
            'Repositories with unresolved index entries are not supported',
        );
    }
    const stagedEntries = await gitBuffer(git, ['ls-files', '--stage', '-z']);
    if (
        splitNull(stagedEntries).some((entry) =>
            entry.subarray(0, 7).equals(Buffer.from('160000 ')),
        )
    ) {
        throw unsupported(
            'Repositories containing Git submodules are not supported',
        );
    }

    const sparse = await runGit(
        git,
        ['config', '--bool', 'core.sparseCheckout'],
        {
            allowedExitCodes: [0, 1],
        },
    );
    if (sparse.code === 0 && decodeLine(sparse.stdout) === 'true') {
        throw unsupported('Sparse checkouts are not supported');
    }

    const operationPaths = [
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'BISECT_LOG',
        'rebase-apply',
        'rebase-merge',
        'sequencer',
        'index.lock',
        'HEAD.lock',
        'packed-refs.lock',
        'shallow.lock',
    ];
    for (const name of operationPaths) {
        const result = await runGit(git, ['rev-parse', '--git-path', name]);
        const operationPath = absoluteGitPath(
            repository.root,
            decodeLine(result.stdout),
        );
        if (await exists(operationPath)) {
            const reason = name.endsWith('.lock')
                ? `Repository has an active Git lock (${name})`
                : `Repository has an in-progress Git operation (${name})`;
            throw unsupported(reason);
        }
    }
}

async function fingerprintWorktree(
    git: GitContext,
    status: Buffer,
): Promise<GitStateFingerprint> {
    const hash = createHash('sha256');
    addField(hash, Buffer.from('flue-git-worktree-v1'));
    addField(hash, status);
    await pipeGitToHash(
        git,
        [
            'diff',
            '--binary',
            '--full-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--ignore-submodules=none',
            '--',
        ],
        hash,
    );

    const untracked = await gitBuffer(git, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
    ]);
    for (const pathBuffer of splitNull(untracked)) {
        const relativePath = pathBuffer.toString('utf8');
        if (!Buffer.from(relativePath).equals(pathBuffer)) {
            throw unsupported('Non-UTF-8 repository paths are not supported');
        }
        const absolutePath = resolve(git.cwd, relativePath);
        const before = await lstat(absolutePath);
        addField(hash, pathBuffer);
        if (before.isSymbolicLink()) {
            addField(hash, Buffer.from('symlink'));
            addField(hash, Buffer.from(await readlink(absolutePath)));
        } else if (before.isFile()) {
            addField(
                hash,
                Buffer.from(before.mode & 0o111 ? 'executable' : 'file'),
            );
            addField(hash, await readFile(absolutePath));
        } else {
            throw unsupported(
                `Unsupported untracked file type: ${relativePath}`,
            );
        }
        const after = await lstat(absolutePath);
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.mode !== after.mode
        ) {
            throw new GitPreflightError(
                'repository_changed',
                `Repository file changed during preflight: ${relativePath}`,
            );
        }
    }
    return frozenFingerprint(hash.digest('hex'));
}

function parseStatus(status: Buffer): {
    indexDirty: boolean;
    worktreeDirty: boolean;
    untracked: boolean;
} {
    let indexDirty = false;
    let worktreeDirty = false;
    let untracked = false;
    const entries = splitNull(status);
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index] as Buffer;
        const x = String.fromCharCode(entry[0] ?? 32);
        const y = String.fromCharCode(entry[1] ?? 32);
        if (x === '?' && y === '?') {
            untracked = true;
            worktreeDirty = true;
        } else {
            if (x !== ' ') indexDirty = true;
            if (y !== ' ') worktreeDirty = true;
            // Porcelain v1 emits an additional NUL field for rename sources.
            if (x === 'R' || x === 'C' || y === 'R' || y === 'C') index += 1;
        }
    }
    return { indexDirty, worktreeDirty, untracked };
}

async function hashGitOutput(
    git: GitContext,
    args: string[],
    domain: string,
): Promise<GitStateFingerprint> {
    const hash = createHash('sha256');
    addField(hash, Buffer.from(domain));
    await pipeGitToHash(git, args, hash);
    return frozenFingerprint(hash.digest('hex'));
}

async function pipeGitToHash(
    context: GitContext,
    args: string[],
    hash: ReturnType<typeof createHash>,
): Promise<void> {
    const child = spawn('git', ['-C', context.cwd, ...args], {
        env: context.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => hash.update(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    const code = await new Promise<number>((accept, reject) => {
        child.once('error', reject);
        child.once('close', (value) => accept(value ?? 1));
    });
    if (code !== 0) throw commandError(args, code, Buffer.concat(errors));
}

async function gitText(context: GitContext, args: string[]): Promise<string> {
    return decodeLine((await runGit(context, args)).stdout);
}

async function gitBuffer(context: GitContext, args: string[]): Promise<Buffer> {
    return (await runGit(context, args)).stdout;
}

export function runGit(
    context: GitContext,
    args: string[],
    options: { allowedExitCodes?: readonly number[]; input?: Buffer } = {},
): Promise<GitResult> {
    return new Promise((accept, reject) => {
        const child = spawn('git', ['-C', context.cwd, ...args], {
            env: context.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.on('error', () => {});
        child.stdin.end(options.input);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (code) => {
            const result = {
                code: code ?? 1,
                stdout: Buffer.concat(stdout),
                stderr: Buffer.concat(stderr),
            };
            const allowed = options.allowedExitCodes ?? [0];
            if (allowed.includes(result.code)) accept(result);
            else reject(commandError(args, result.code, result.stderr));
        });
    });
}

function commandError(
    args: string[],
    code: number,
    stderr: Buffer,
): GitPreflightError {
    const detail = stderr.toString('utf8').trim();
    return new GitPreflightError(
        'git_command_failed',
        `Git command failed (${code}): git ${args.join(' ')}${detail ? `: ${detail}` : ''}`,
    );
}

export function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...source,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
    };
    for (const key of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_COMMON_DIR',
        'GIT_NAMESPACE',
        'GIT_PREFIX',
    ]) {
        delete env[key];
    }
    return env;
}

function digestFields(
    domain: string,
    fields: readonly string[],
): GitStateFingerprint {
    const hash = createHash('sha256');
    addField(hash, Buffer.from(domain));
    for (const field of fields) addField(hash, Buffer.from(field));
    return frozenFingerprint(hash.digest('hex'));
}

function addField(hash: ReturnType<typeof createHash>, value: Buffer): void {
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(value.length));
    hash.update(size);
    hash.update(value);
}

function frozenFingerprint(value: string): GitStateFingerprint {
    return Object.freeze({ algorithm: 'sha256', value });
}

function splitNull(value: Buffer): Buffer[] {
    const result: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === 0) {
            result.push(value.subarray(start, index));
            start = index + 1;
        }
    }
    if (start < value.length) result.push(value.subarray(start));
    return result;
}

function absoluteGitPath(root: string, path: string): string {
    return isAbsolute(path) ? path : resolve(root, path);
}

function decodeLine(value: Buffer): string {
    return value.toString('utf8').replace(/[\r\n]+$/u, '');
}

async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return false;
        throw error;
    }
}

function unsupported(message: string): GitPreflightError {
    return new GitPreflightError('unsupported_repository_state', message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
