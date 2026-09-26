import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    gitEnvironment,
    preflightGitRepository,
    runGit,
    trackedNonGitlinkPaths,
} from './git-preflight.ts';
import {
    type FileImage,
    PatchManager,
    type PatchRevision,
} from './patch-publication.ts';
import type { RunStore } from './run-storage.ts';

export interface CommitRequest {
    requested: boolean;
    message?: string;
}

export type FinalizationResult =
    | { status: 'published'; commit: null }
    | { status: 'committed'; commit: string; message: string }
    | { status: 'blocked'; commit: null; reason: string };

/**
 * Interpret only direct instructions to commit. Merely mentioning commits or
 * asking not to commit is deliberately not authority to change HEAD.
 */
export function commitRequestFromPrompt(
    prompt: string,
    forced = false,
): CommitRequest {
    const negative =
        /\b(?:do\s+not|don't|dont|never|without)\s+(?:create\s+(?:a\s+)?|make\s+(?:a\s+)?|git\s+)?commit(?:ting)?\b/iu.test(
            prompt,
        ) || /\bno\s+commit\b/iu.test(prompt);
    const explicit =
        /\b(?:please\s+)?(?:create|make)\s+(?:a\s+)?commit\b/iu.test(prompt) ||
        /\bgit\s+commit\b/iu.test(prompt) ||
        /\bcommit\s+(?:the\s+|these\s+|all\s+|my\s+)?(?:approved\s+)?(?:changes|patch|work|implementation|code|result|files)\b/iu.test(
            prompt,
        ) ||
        /\bcommit\s+with\s+(?:the\s+)?message\b/iu.test(prompt) ||
        /\band\s+(?:please\s+)?commit(?:\s+(?:it|this|now))?[.!]?(?:\s*$)/iu.test(
            prompt,
        );
    const requested = forced || (!negative && explicit);
    if (!requested) return { requested: false };

    const supplied = prompt.match(
        /\bcommit(?:\s+(?:the\s+|these\s+|all\s+|my\s+)?(?:approved\s+)?(?:changes|patch|work|implementation|code|result|files))?\s+(?:with\s+(?:the\s+)?message|message\s*:)\s*(?:["“]([^"”\r\n]+)["”]|'([^'\r\n]+)'|([^\r\n.;]+))/iu,
    );
    const message = supplied
        ?.slice(1)
        .find((value) => value?.trim())
        ?.trim();
    return message ? { requested: true, message } : { requested: true };
}

/** Publishes the reviewed revision, then optionally creates one hook-verified commit. */
export class CommitManager {
    private readonly env: NodeJS.ProcessEnv;
    private readonly patches: PatchManager;
    private readonly store: RunStore;

    constructor(store: RunStore, env = process.env, patches?: PatchManager) {
        this.store = store;
        this.env = gitEnvironment(env);
        this.patches = patches ?? new PatchManager(store, env);
    }

    async finalize(
        id: string,
        approvedRevisionHash: string,
        request: CommitRequest = { requested: false },
    ): Promise<FinalizationResult> {
        await this.patches.publish(id, approvedRevisionHash);
        if (!request.requested) return { status: 'published', commit: null };
        const revision = await this.patches.published(id);
        if (!revision || revision.revisionHash !== approvedRevisionHash) {
            return {
                status: 'blocked',
                commit: null,
                reason: 'Published revision receipt is missing or does not match approval',
            };
        }
        return await this.commit(id, revision, request.message);
    }

    private async commit(
        id: string,
        revision: PatchRevision,
        suppliedMessage?: string,
    ): Promise<FinalizationResult> {
        if (revision.changes.length === 0) {
            return {
                status: 'blocked',
                commit: null,
                reason: 'The approved patch is empty; no commit was created',
            };
        }
        const run = await this.store.read(id);
        if (run.status !== 'completed') {
            return {
                status: 'blocked',
                commit: null,
                reason: 'Only a completed, published run can be committed',
            };
        }
        const baseline = await this.patches.baselineState(id);
        const root = baseline.git.repository.root;
        const lock = join(
            baseline.git.repository.gitDirectory,
            'flue-publication.lock',
        );
        const index = join(
            this.store.runDirectory(id),
            `commit-index-${randomUUID()}`,
        );
        const message =
            suppliedMessage?.trim() || 'flue-agent: apply approved changes';

        try {
            await mkdir(lock);
        } catch (error) {
            if (isNodeError(error) && error.code === 'EEXIST') {
                return {
                    status: 'blocked',
                    commit: null,
                    reason: 'Another publication or commit is in progress',
                };
            }
            throw error;
        }

        try {
            const before = await sourceFingerprint(root, this.env);
            const state = await preflightGitRepository(root, {
                allowDirty: true,
                env: this.env,
            });
            if (
                state.head !== baseline.git.head ||
                state.branch !== baseline.git.branch ||
                state.index.fingerprint.value !==
                    baseline.git.index.fingerprint.value
            ) {
                return blocked('Repository changed after publication');
            }
            for (const change of revision.changes) {
                if (
                    !sameImage(await fileImage(root, change.path), change.after)
                )
                    return blocked(
                        `Published file changed before commit: ${change.path}`,
                    );
                const parentImage = await imageAtHead(
                    root,
                    this.env,
                    baseline.git.head,
                    change.path,
                );
                if (!sameGitImage(parentImage, change.before)) {
                    return blocked(
                        `Cannot commit over pre-existing changes in approved path: ${change.path}`,
                    );
                }
            }

            const commitEnv = { ...this.env, GIT_INDEX_FILE: index };
            const approvedEntries = new Map<
                string,
                { mode: string; object: string } | null
            >();
            await runGit({ cwd: root, env: commitEnv }, [
                'read-tree',
                baseline.git.head,
            ]);
            for (const change of revision.changes) {
                if (change.after === null) {
                    approvedEntries.set(change.path, null);
                    await runGit({ cwd: root, env: commitEnv }, [
                        'update-index',
                        '--force-remove',
                        '--',
                        change.path,
                    ]);
                    continue;
                }
                const data = Buffer.from(change.after.data, 'base64');
                const object = (
                    await runGit(
                        { cwd: root, env: commitEnv },
                        ['hash-object', '-w', '--stdin'],
                        { input: data },
                    )
                ).stdout
                    .toString('utf8')
                    .trim();
                const mode =
                    change.after.kind === 'symlink'
                        ? '120000'
                        : change.after.mode & 0o111
                          ? '100755'
                          : '100644';
                approvedEntries.set(change.path, { mode, object });
                await runGit({ cwd: root, env: commitEnv }, [
                    'update-index',
                    '--add',
                    '--cacheinfo',
                    mode,
                    object,
                    change.path,
                ]);
            }
            const expectedTree = (
                await runGit({ cwd: root, env: commitEnv }, ['write-tree'])
            ).stdout
                .toString('utf8')
                .trim();

            const attempt = await runGit(
                { cwd: root, env: commitEnv },
                ['commit', '-m', message],
                { allowedExitCodes: [0, 1, 2, 128] },
            );
            const head = await currentHead(root, this.env);
            if (attempt.code !== 0) {
                if (head !== baseline.git.head)
                    await rollbackHead(root, this.env, baseline.git.head, head);
                return blocked(
                    `Commit hook or Git rejected the commit${attempt.stderr.length ? `: ${attempt.stderr.toString('utf8').trim()}` : ''}`,
                );
            }

            const parent = await gitLine(root, this.env, [
                'rev-parse',
                'HEAD^',
            ]);
            const tree = await gitLine(root, this.env, [
                'show',
                '-s',
                '--format=%T',
                'HEAD',
            ]);
            const after = await sourceFingerprint(root, this.env);
            const afterState = await preflightGitRepository(root, {
                allowDirty: true,
                env: this.env,
            });
            const valid =
                parent === baseline.git.head &&
                tree === expectedTree &&
                before === after &&
                afterState.index.fingerprint.value ===
                    baseline.git.index.fingerprint.value;
            if (!valid) {
                await rollbackHead(root, this.env, baseline.git.head, head);
                return blocked(
                    'Commit hooks modified reviewed output or the commit did not match the approved patch',
                );
            }

            // Advance only approved paths in the real index. This leaves an
            // ordinary clean checkout for a clean baseline while preserving
            // unrelated user staging from --allow-dirty runs.
            for (const [path, entry] of approvedEntries) {
                if (entry === null) {
                    await runGit({ cwd: root, env: this.env }, [
                        'update-index',
                        '--force-remove',
                        '--',
                        path,
                    ]);
                } else {
                    await runGit({ cwd: root, env: this.env }, [
                        'update-index',
                        '--add',
                        '--cacheinfo',
                        entry.mode,
                        entry.object,
                        path,
                    ]);
                }
            }
            if ((await currentHead(root, this.env)) !== head)
                return blocked(
                    'Repository HEAD changed while finalizing commit',
                );
            return { status: 'committed', commit: head, message };
        } catch (error) {
            const head = await currentHead(root, this.env).catch(
                () => baseline.git.head,
            );
            if (head !== baseline.git.head)
                await rollbackHead(
                    root,
                    this.env,
                    baseline.git.head,
                    head,
                ).catch(() => {});
            return blocked(
                `Commit failed without bypassing hooks: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            await rm(index, { force: true });
            await rm(lock, { recursive: true, force: true });
        }
    }
}

function blocked(reason: string): FinalizationResult {
    return { status: 'blocked', commit: null, reason };
}

async function rollbackHead(
    root: string,
    env: NodeJS.ProcessEnv,
    expected: string,
    actual: string,
): Promise<void> {
    await runGit({ cwd: root, env }, ['update-ref', 'HEAD', expected, actual]);
}

async function currentHead(
    root: string,
    env: NodeJS.ProcessEnv,
): Promise<string> {
    return await gitLine(root, env, ['rev-parse', 'HEAD']);
}

async function gitLine(
    root: string,
    env: NodeJS.ProcessEnv,
    args: string[],
): Promise<string> {
    return (await runGit({ cwd: root, env }, args)).stdout
        .toString('utf8')
        .trim();
}

async function sourceFingerprint(
    root: string,
    env: NodeJS.ProcessEnv,
): Promise<string> {
    const tracked = await trackedNonGitlinkPaths(root, env);
    const untracked = (
        await runGit({ cwd: root, env }, [
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
        ])
    ).stdout
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
    const names = [...new Set([...tracked, ...untracked])].sort();
    const hash = createHash('sha256');
    for (const path of names) {
        hash.update(path).update('\0');
        const image = await fileImage(root, path);
        hash.update(JSON.stringify(image)).update('\0');
    }
    return hash.digest('hex');
}

async function fileImage(
    root: string,
    path: string,
): Promise<FileImage | null> {
    try {
        const entry = await lstat(join(root, path));
        if (entry.isSymbolicLink())
            return {
                kind: 'symlink',
                mode: 0o777,
                data: Buffer.from(await readlink(join(root, path))).toString(
                    'base64',
                ),
            };
        if (!entry.isFile())
            throw new Error(`Unsupported source file: ${path}`);
        return {
            kind: 'file',
            mode: entry.mode & 0o777,
            data: (await readFile(join(root, path))).toString('base64'),
        };
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return null;
        throw error;
    }
}

async function imageAtHead(
    root: string,
    env: NodeJS.ProcessEnv,
    head: string,
    path: string,
): Promise<FileImage | null> {
    const listing = await runGit({ cwd: root, env }, [
        'ls-tree',
        '-z',
        head,
        '--',
        path,
    ]);
    if (listing.stdout.length === 0) return null;
    const header = listing.stdout.toString('utf8').split('\0')[0];
    const match = header?.match(/^(\d+) blob ([0-9a-f]+)\t/u);
    if (!match?.[1] || !match[2])
        throw new Error(`Unsupported Git tree entry: ${path}`);
    const data = (
        await runGit({ cwd: root, env }, ['cat-file', 'blob', match[2]])
    ).stdout.toString('base64');
    return match[1] === '120000'
        ? { kind: 'symlink', mode: 0o777, data }
        : {
              kind: 'file',
              mode: match[1] === '100755' ? 0o755 : 0o644,
              data,
          };
}

function sameImage(a: FileImage | null, b: FileImage | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function sameGitImage(a: FileImage | null, b: FileImage | null): boolean {
    if (a === null || b === null) return a === b;
    return (
        a.kind === b.kind &&
        a.data === b.data &&
        (a.kind === 'symlink' ||
            Boolean(a.mode & 0o111) === Boolean(b.mode & 0o111))
    );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
