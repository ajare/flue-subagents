import type { AgentConfiguration } from './config.ts';
import {
    createDelegationBudget,
    type DelegationBudget,
    DelegationBudgetExceededError,
    type SubagentRole,
} from './result-contracts.ts';
import type { RunStore } from './run-storage.ts';

export type ExhaustedLimit = 'delegations' | 'repair_cycles' | 'run_timeout';

/** A policy limit is an expected blocked outcome, not an infrastructure fault. */
export class OrchestrationLimitError extends Error {
    readonly code = 'orchestration_limit_exhausted';
    readonly outcome = 'blocked';
    readonly limitName: ExhaustedLimit;
    readonly limit: number;
    readonly used: number;

    constructor(limitName: ExhaustedLimit, limit: number, used: number) {
        super(
            `Orchestration limit ${limitName} exhausted (limit ${limit}, used ${used})`,
        );
        this.name = 'OrchestrationLimitError';
        this.limitName = limitName;
        this.limit = limit;
        this.used = used;
    }
}

/** A fair, abort-aware asynchronous concurrency gate. */
export class ConcurrencyGate {
    readonly limit: number;
    private activeCount = 0;
    private readonly waiting: Array<{
        resolve: (release: () => void) => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
    }> = [];

    constructor(limit: number) {
        if (!Number.isSafeInteger(limit) || limit <= 0)
            throw new TypeError('Concurrency limit must be a positive integer');
        this.limit = limit;
    }

    get active(): number {
        return this.activeCount;
    }

    get queued(): number {
        return this.waiting.length;
    }

    async run<T>(
        operation: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        const release = await this.acquire(signal);
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private acquire(signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) return Promise.reject(abortError(signal.reason));
        if (this.activeCount < this.limit) {
            this.activeCount += 1;
            return Promise.resolve(this.releaseOnce());
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                signal,
            } as (typeof this.waiting)[number];
            waiter.onAbort = () => {
                const index = this.waiting.indexOf(waiter);
                if (index >= 0) this.waiting.splice(index, 1);
                reject(abortError(signal?.reason));
            };
            signal?.addEventListener('abort', waiter.onAbort, { once: true });
            this.waiting.push(waiter);
        });
    }

    private releaseOnce(): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const waiter = this.waiting.shift();
            if (waiter) {
                if (waiter.onAbort)
                    waiter.signal?.removeEventListener('abort', waiter.onAbort);
                waiter.resolve(this.releaseOnce());
            } else {
                this.activeCount -= 1;
            }
        };
    }
}

export interface OrchestrationLimitsOptions {
    configuration: AgentConfiguration;
    /** Delegation attempts already recorded in a resumed run. */
    usedDelegations?: number;
    /** Repair cycles already recorded in a resumed run. */
    usedRepairCycles?: number;
    /** Runtime is measured from this instant. */
    startedAt?: number;
    now?: () => number;
}

/** Shared per-run policy state. All delegation paths must use this instance. */
export class OrchestrationLimits {
    readonly configuration: AgentConfiguration;
    readonly delegationBudget: DelegationBudget & {
        readonly used: number;
        readonly remaining: number;
    };
    readonly readOnly: ConcurrencyGate;
    readonly implementers: ConcurrencyGate;
    readonly startedAt: number;
    private repairs: number;
    private readonly now: () => number;

    constructor(
        configuration: AgentConfiguration,
        options: Omit<OrchestrationLimitsOptions, 'configuration'> = {},
    ) {
        this.configuration = configuration;
        this.now = options.now ?? Date.now;
        this.startedAt = options.startedAt ?? this.now();
        this.repairs = options.usedRepairCycles ?? 0;
        assertUsed(
            this.repairs,
            configuration.maxRepairCycles,
            'repair cycles',
        );
        const budget = createDelegationBudget(
            configuration.maxDelegations,
            options.usedDelegations ?? 0,
        );
        const limits = this;
        this.delegationBudget = {
            get used() {
                return budget.used;
            },
            get remaining() {
                return budget.remaining;
            },
            consume(role) {
                limits.checkRuntime();
                try {
                    budget.consume(role);
                } catch (error) {
                    if (!(error instanceof DelegationBudgetExceededError))
                        throw error;
                    throw new OrchestrationLimitError(
                        'delegations',
                        configuration.maxDelegations,
                        budget.used,
                    );
                }
            },
        };
        this.readOnly = new ConcurrencyGate(configuration.readOnlyConcurrency);
        this.implementers = new ConcurrencyGate(
            configuration.implementerConcurrency,
        );
    }

    get repairCyclesUsed(): number {
        return this.repairs;
    }

    get remainingRuntimeMs(): number {
        return Math.max(
            0,
            this.configuration.runTimeoutMs - (this.now() - this.startedAt),
        );
    }

    checkRuntime(): void {
        const used = this.now() - this.startedAt;
        if (used >= this.configuration.runTimeoutMs)
            throw new OrchestrationLimitError(
                'run_timeout',
                this.configuration.runTimeoutMs,
                used,
            );
    }

    consumeDelegation(role: SubagentRole): void {
        this.delegationBudget.consume(role);
    }

    consumeRepairCycle(): void {
        this.checkRuntime();
        if (this.repairs >= this.configuration.maxRepairCycles)
            throw new OrchestrationLimitError(
                'repair_cycles',
                this.configuration.maxRepairCycles,
                this.repairs,
            );
        this.repairs += 1;
    }

    runReadOnly<T>(
        operation: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        this.checkRuntime();
        return this.readOnly.run(async () => {
            this.checkRuntime();
            return operation();
        }, signal);
    }

    runImplementer<T>(
        operation: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        this.checkRuntime();
        return this.implementers.run(async () => {
            this.checkRuntime();
            return operation();
        }, signal);
    }

    /** Abort cooperative work and reject when the total run deadline expires. */
    async runWithinDeadline<T>(
        operation: (signal: AbortSignal) => Promise<T>,
        parentSignal?: AbortSignal,
    ): Promise<T> {
        this.checkRuntime();
        const remaining = this.remainingRuntimeMs;
        const controller = new AbortController();
        const signal = parentSignal
            ? AbortSignal.any([parentSignal, controller.signal])
            : controller.signal;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                const error = new OrchestrationLimitError(
                    'run_timeout',
                    this.configuration.runTimeoutMs,
                    this.now() - this.startedAt,
                );
                reject(error);
                controller.abort(error);
            }, remaining);
            timer.unref();
        });
        try {
            return await Promise.race([operation(signal), timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

/** Persist policy exhaustion as blocked while leaving infrastructure failures alone. */
export async function blockOnLimit<T>(
    store: RunStore,
    runId: string,
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof OrchestrationLimitError) {
            const run = await store.read(runId);
            if (
                run.status === 'running' ||
                run.status === 'needs_input' ||
                run.status === 'interrupted'
            )
                await store.update(runId, { status: 'blocked' });
        }
        throw error;
    }
}

function assertUsed(used: number, limit: number, label: string): void {
    if (!Number.isSafeInteger(used) || used < 0 || used > limit)
        throw new TypeError(`Used ${label} must be between zero and its limit`);
}

function abortError(reason: unknown): DOMException {
    return new DOMException(
        reason instanceof Error ? reason.message : 'Operation was cancelled',
        'AbortError',
    );
}
