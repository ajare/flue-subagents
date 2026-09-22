import { spawn } from 'node:child_process';
import type { TestContext } from 'node:test';

export interface CliResult {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
}

/** Run a Node entrypoint without a shell; keep stdin open for interactive tests. */
export function startCli(
    t: TestContext,
    entrypoint: string,
    args: string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
) {
    const child = spawn(process.execPath, [entrypoint, ...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });
    // Early CLI exits may close stdin before all supplied input is consumed.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') child.emit('error', error);
    });
    const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
    }, options.timeoutMs ?? 10_000);
    const result = new Promise<CliResult>((resolve, reject) => {
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (timedOut)
                reject(new Error(`CLI timed out: ${entrypoint}\n${stderr}`));
            else resolve({ stdout, stderr, code, signal });
        });
    });
    // Attach a handler immediately, even when the caller waits for readiness first.
    void result.catch(() => {});
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
        await result.catch(() => {});
    });
    return {
        child,
        result,
        signal: (signal: NodeJS.Signals) => child.kill(signal),
    };
}

export async function runCli(
    t: TestContext,
    entrypoint: string,
    args: string[] = [],
    options: Parameters<typeof startCli>[3] & { stdin?: string } = {},
) {
    const cli = startCli(t, entrypoint, args, options);
    cli.child.stdin.end(options.stdin ?? '');
    return cli.result;
}
