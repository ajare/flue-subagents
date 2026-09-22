import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Sandbox, SandboxFactory, ShellResult } from '@flue/runtime';
import type { CommandAuditSink } from '../command-audit.ts';
import { readOnlyLocal } from './read-only-local.ts';

/** File API confinement plus workspace accounting. Shell remains trusted-local. */
export function workspaceLocal(options: {
    cwd: string;
    signal?: AbortSignal;
    env: Record<string, string>;
    checkLimit: () => Promise<unknown>;
    commandTimeoutMs: number;
    afterMutation?: () => Promise<unknown>;
    commandAudit?: CommandAuditSink;
}): SandboxFactory {
    const base = readOnlyLocal(options.cwd, options.env);
    return {
        ...base,
        async createSandbox(input) {
            const sandbox = await base.createSandbox(input);
            const root = await realpath(options.cwd);
            const resolvePath = (path: string) => {
                const result = resolve(root, path);
                const difference = relative(root, result);
                if (
                    difference === '..' ||
                    difference.startsWith('../') ||
                    isAbsolute(difference) ||
                    difference.split(/[\\/]/u).includes('.git')
                ) {
                    throw new Error(`Path is outside workspace files: ${path}`);
                }
                return result;
            };
            const safePath = async (path: string) => {
                const result = resolvePath(path);
                // Reject symlink escapes, including dangling links and links in
                // parent directories of files that do not exist yet.
                let ancestor = result;
                for (;;) {
                    try {
                        await lstat(ancestor);
                        resolvePath(await realpath(ancestor));
                        break;
                    } catch (error) {
                        if (
                            !(
                                error instanceof Error &&
                                'code' in error &&
                                error.code === 'ENOENT'
                            )
                        )
                            throw error;
                        // A dangling symlink must not be treated as a missing path.
                        const entry = await lstat(ancestor).catch(() => null);
                        if (entry?.isSymbolicLink())
                            throw new Error(
                                `Dangling workspace symlink: ${path}`,
                            );
                        if (ancestor === root) throw error;
                        ancestor = dirname(ancestor);
                    }
                }
                return result;
            };
            const checked = async <T>(
                operation: () => Promise<T>,
            ): Promise<T> => {
                options.signal?.throwIfAborted();
                await options.checkLimit();
                try {
                    return await operation();
                } finally {
                    await options.checkLimit();
                    await options.afterMutation?.();
                }
            };
            const guarded: Sandbox = {
                cwd: root,
                resolvePath,
                readFile: async (path) =>
                    sandbox.readFile(await safePath(path)),
                readFileBuffer: async (path) =>
                    sandbox.readFileBuffer(await safePath(path)),
                stat: async (path) => sandbox.stat(await safePath(path)),
                readdir: async (path) =>
                    (await sandbox.readdir(await safePath(path))).filter(
                        (name) => name !== '.git',
                    ),
                exists: async (path) => {
                    try {
                        return await sandbox.exists(await safePath(path));
                    } catch {
                        return false;
                    }
                },
                writeFile: (path, content) =>
                    checked(async () =>
                        sandbox.writeFile(await safePath(path), content),
                    ),
                mkdir: (path, settings) =>
                    checked(async () =>
                        sandbox.mkdir(await safePath(path), settings),
                    ),
                rm: (path, settings) =>
                    checked(async () => {
                        const target = await safePath(path);
                        if (target === root)
                            throw new Error('Cannot remove the workspace root');
                        return sandbox.rm(target, settings);
                    }),
                exec: (command, settings) =>
                    checked(async () => {
                        const cwd = await safePath(settings?.cwd ?? root);
                        const controller = new AbortController();
                        let pending: Promise<void> | undefined;
                        let limitFailure: unknown;
                        const timer = setInterval(() => {
                            if (pending || controller.signal.aborted) return;
                            pending = options
                                .checkLimit()
                                .then(
                                    () => {},
                                    (error: unknown) => {
                                        limitFailure = error;
                                        controller.abort(error);
                                    },
                                )
                                .finally(() => {
                                    pending = undefined;
                                });
                        }, 250);
                        timer.unref();
                        const startedAt = new Date();
                        const started = performance.now();
                        let result: ShellResult | undefined;
                        let commandError: unknown;
                        try {
                            result = await sandbox.exec(command, {
                                ...settings,
                                cwd,
                                signal: AbortSignal.any([
                                    controller.signal,
                                    ...(settings?.signal
                                        ? [settings.signal]
                                        : []),
                                    ...(options.signal ? [options.signal] : []),
                                ]),
                                timeoutMs: Math.min(
                                    settings?.timeoutMs ??
                                        options.commandTimeoutMs,
                                    options.commandTimeoutMs,
                                ),
                            });
                        } catch (error) {
                            commandError = error;
                        } finally {
                            clearInterval(timer);
                            await pending;
                            await options.commandAudit?.record({
                                timestamp: startedAt.toISOString(),
                                command,
                                cwd,
                                durationMs: Math.max(
                                    0,
                                    Math.round(performance.now() - started),
                                ),
                                exitCode: result?.exitCode ?? null,
                                stdout: result?.stdout ?? '',
                                stderr:
                                    result?.stderr ??
                                    errorMessage(commandError),
                                outcome: result
                                    ? 'completed'
                                    : isAbortError(commandError)
                                      ? 'cancelled'
                                      : 'failed',
                            });
                        }
                        if (limitFailure) throw limitFailure;
                        if (commandError) throw commandError;
                        return result as ShellResult;
                    }),
            };
            return guarded;
        },
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error
        ? error.message
        : error === undefined
          ? ''
          : String(error);
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}
