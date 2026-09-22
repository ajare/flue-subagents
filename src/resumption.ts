import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionRequest } from './cli.ts';
import {
    assertGitFingerprint,
    preflightGitRepository,
    type GitPreflightResult,
} from './git-preflight.ts';
import type { RunStore } from './run-storage.ts';

interface Checkpoint {
    version: 1;
    request: ExecutionRequest;
    workspace: GitPreflightResult;
}

/** Written only after execution has stopped; an absent checkpoint fails closed. */
export async function checkpointRun(
    store: RunStore,
    id: string,
    request: ExecutionRequest,
): Promise<void> {
    const run = await store.read(id);
    if (!run.locations.workspace) throw new Error('Run has no workspace');
    const checkpoint: Checkpoint = {
        version: 1,
        request,
        workspace: await preflightGitRepository(run.locations.workspace, {
            allowDirty: true,
        }),
    };
    const path = join(store.runDirectory(id), 'resume.json');
    const file = await open(`${path}.tmp`, 'w', 0o600);
    try {
        await file.writeFile(JSON.stringify(checkpoint));
        await file.sync();
    } finally {
        await file.close();
    }
    await rename(`${path}.tmp`, path);
}

export async function loadContinuation(
    store: RunStore,
    id: string,
    answer?: string,
): Promise<ExecutionRequest> {
    const run = await store.read(id);
    if (run.status !== 'interrupted' && run.status !== 'needs_input')
        throw new Error(`Run ${id} is not resumable (${run.status})`);
    if (run.status === 'needs_input' && !answer?.trim())
        throw new Error('This run requires an answer');
    const checkpoint: Checkpoint = JSON.parse(
        await readFile(join(store.runDirectory(id), 'resume.json'), 'utf8'),
    );
    if (
        checkpoint.version !== 1 ||
        checkpoint.request.repository !== run.repository.path ||
        checkpoint.workspace.repository.root !== run.locations.workspace
    )
        throw new Error('Incompatible resume checkpoint');
    const identity = await stat(run.repository.path);
    if (
        identity.dev !== run.repository.device ||
        identity.ino !== run.repository.inode
    )
        throw new Error('Repository identity changed');
    await assertGitFingerprint(checkpoint.request.repositoryState);
    await assertGitFingerprint(checkpoint.workspace);
    return { ...checkpoint.request, configuration: run.configuration };
}

/** Exclusive ownership across CLI processes. Never steal an ambiguous stale lock. */
export async function lockRun(
    store: RunStore,
    id: string,
): Promise<() => Promise<void>> {
    const path = join(store.runDirectory(id), 'execution.lock');
    const file = await open(path, 'wx', 0o600);
    await file.close();
    return () => rm(path, { force: true });
}

export function cancellationSignals(controller: AbortController): () => void {
    const interrupt = () =>
        controller.abort(new DOMException('Run interrupted', 'AbortError'));
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    return () => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
    };
}
