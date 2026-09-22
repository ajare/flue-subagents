/** FIFO coordinator for repository-mutating tool calls. */
export class MutationCoordinator {
    private tail: Promise<void> = Promise.resolve();

    async run<T>(
        signal: AbortSignal | undefined,
        operation: () => Promise<T>,
    ): Promise<T> {
        let release!: () => void;
        const predecessor = this.tail;
        this.tail = new Promise<void>((resolve) => {
            release = resolve;
        });

        await predecessor;
        try {
            if (signal?.aborted) throw abortError(signal.reason);
            return await operation();
        } finally {
            release();
        }
    }
}

function abortError(reason: unknown): DOMException {
    return new DOMException(
        reason instanceof Error ? reason.message : 'Operation was cancelled',
        'AbortError',
    );
}

/** Shared because all implementer task sessions operate on one workspace. */
export const repositoryMutationCoordinator = new MutationCoordinator();
