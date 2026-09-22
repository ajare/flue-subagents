import {
    completionEligibility,
    replayLedger,
    type LedgerEvent,
} from './delegation-ledger.ts';

/** Reader/writer boundary: reviewers may overlap, implementers never overlap reviews. */
export class ReviewBoundary {
    private readers = 0;
    private writer = false;
    private queue: { write: boolean; start: () => void }[] = [];

    run<T>(write: boolean, operation: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({
                write,
                start: () => {
                    if (write) this.writer = true;
                    else this.readers++;
                    void Promise.resolve()
                        .then(operation)
                        .then(resolve, reject)
                        .finally(() => {
                            if (write) this.writer = false;
                            else this.readers--;
                            this.drain();
                        });
                },
            });
            this.drain();
        });
    }

    private drain(): void {
        while (!this.writer && this.queue.length) {
            const next = this.queue[0];
            if (!next || (next.write && this.readers > 0)) return;
            this.queue.shift();
            next.start();
        }
    }
}

export function isMutationRun(events: readonly LedgerEvent[]): boolean {
    const state = replayLedger(events);
    return (
        state.patchEpoch > 1 ||
        state.delegations.some((entry) => entry.role === 'implementer')
    );
}

export function assertReviewApproval(events: readonly LedgerEvent[]): void {
    if (!isMutationRun(events)) return;
    const eligibility = completionEligibility(events);
    if (!eligibility.eligible)
        throw new Error(`Review gate: ${eligibility.reasons.join('; ')}`);
}
