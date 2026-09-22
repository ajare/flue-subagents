import { randomUUID } from 'node:crypto';
import type { OrchestrationLimits } from './orchestration-limits.ts';
import {
    type CorrectableDelegationOptions,
    delegateWithValidatedResult,
    type ResultForRole,
    type SubagentRole,
} from './result-contracts.ts';
import type { RunStore } from './run-storage.ts';

export type LimitedDelegationOptions<Role extends SubagentRole> = Omit<
    CorrectableDelegationOptions<Role>,
    'budget'
> & {
    limits: OrchestrationLimits;
    store: RunStore;
    runId: string;
    id?: string;
    parentId?: string;
    taskSummary?: string;
    signal?: AbortSignal;
};

/**
 * Policy entry point for delegation. It applies the role concurrency gate and
 * shares one attempt budget across initial calls and malformed-output retries.
 */
export function delegateWithLimits<Role extends SubagentRole>(
    options: LimitedDelegationOptions<Role>,
): Promise<ResultForRole<Role>> {
    const { limits, signal, ...delegation } = options;
    const run = () =>
        delegateWithLedger({
            ...delegation,
            budget: limits.delegationBudget,
        });
    return options.role === 'implementer'
        ? limits.runImplementer(run, signal)
        : limits.runReadOnly(run, signal);
}

/** Application-owned lifecycle wrapper; IDs are independent of model output/task order. */
export async function delegateWithLedger<Role extends SubagentRole>(
    options: CorrectableDelegationOptions<Role> & {
        store: RunStore;
        runId: string;
        id?: string;
        parentId?: string;
        taskSummary?: string;
    },
): Promise<ResultForRole<Role>> {
    const id = options.id ?? randomUUID();
    const append = (
        ledgerAction: Parameters<RunStore['update']>[1]['ledgerAction'],
    ) => options.store.update(options.runId, { ledgerAction });
    await append({
        type: 'start',
        id,
        parentId: options.parentId ?? null,
        role: options.role,
        task: options.taskSummary ?? options.prompt,
    });
    try {
        const result = await delegateWithValidatedResult({
            ...options,
            async onMalformed(error) {
                await append({
                    type: 'malformed',
                    id,
                    issues: error.issues.map(
                        (issue) => `${issue.path}: ${issue.message}`,
                    ),
                });
                await options.onMalformed?.(error);
            },
            async delegate(prompt, context) {
                if (context.corrective) await append({ type: 'retry', id });
                return options.delegate(prompt, context);
            },
        });
        await append({ type: 'result', id, result });
        return result;
    } catch (error) {
        await append({
            type: 'failure',
            id,
            message:
                error instanceof Error
                    ? error.message || error.name
                    : String(error) || 'Unknown failure',
        });
        throw error;
    }
}
