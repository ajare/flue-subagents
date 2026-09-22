import {
    type FlueExecutionContext,
    type FlueExecutionInterceptor,
    type FlueExecutionOperation,
    type FlueObservation,
    instrument,
} from '@flue/runtime';
import * as v from 'valibot';
import { type LedgerEvent, replayLedger } from './delegation-ledger.ts';
import {
    blockOnLimit,
    type OrchestrationLimits,
} from './orchestration-limits.ts';
import {
    mayIgnoreRoleFailure,
    ResultValidationError,
    type SubagentRole,
    validateSubagentResult,
} from './result-contracts.ts';
import type { RunStore } from './run-storage.ts';
import type { PatchManager } from './patch-publication.ts';
import { ReviewBoundary } from './review-gating.ts';

const text = v.pipe(v.string(), v.minLength(1));
const orchestratorResultSchema = v.strictObject({
    schemaVersion: v.literal(1),
    status: v.picklist(['completed', 'needs_input', 'blocked']),
    summary: text,
    questions: v.array(text),
    failureWaivers: v.optional(
        v.array(
            v.strictObject({
                delegationId: text,
                reason: text,
            }),
        ),
        [],
    ),
});

export type OrchestratorResult = v.InferOutput<typeof orchestratorResultSchema>;

export class OrchestrationDefectError extends Error {
    readonly code = 'orchestration_defect';
    readonly taskId?: string;
    readonly missingSections: readonly string[];

    constructor(
        message: string,
        options: {
            taskId?: string;
            missingSections?: readonly string[];
            cause?: unknown;
        } = {},
    ) {
        super(message, { cause: options.cause });
        this.name = 'OrchestrationDefectError';
        this.taskId = options.taskId;
        this.missingSections = Object.freeze([
            ...(options.missingSections ?? []),
        ]);
    }
}

/** Validate the root agent's machine-readable terminal decision. */
export function validateOrchestratorResult(
    output: unknown,
): OrchestratorResult {
    let value = output;
    if (typeof output === 'string') {
        try {
            value = JSON.parse(output);
        } catch (cause) {
            throw new OrchestrationDefectError(
                'Orchestrator result must be one JSON object',
                { cause },
            );
        }
    }
    const parsed = v.safeParse(orchestratorResultSchema, value);
    if (!parsed.success) {
        throw new OrchestrationDefectError(
            `Invalid orchestrator result: ${parsed.issues
                .map((issue) => issue.message)
                .join('; ')}`,
        );
    }
    if (parsed.output.status === 'needs_input') {
        if (parsed.output.questions.length === 0) {
            throw new OrchestrationDefectError(
                'A needs_input result must contain at least one precise question',
            );
        }
    } else if (parsed.output.questions.length !== 0) {
        throw new OrchestrationDefectError(
            'A completed result cannot contain clarification questions',
        );
    }
    return parsed.output;
}

export function formatOrchestratorResult(result: OrchestratorResult): string {
    if (result.status !== 'needs_input') return result.summary;
    return `${result.summary}\n\nClarification needed:\n${result.questions
        .map((question) => `- ${question}`)
        .join('\n')}`;
}

/** Fail closed unless every task failure has a permitted, explicit waiver. */
export function assertOrchestrationIntegrity(
    result: OrchestratorResult,
    events: readonly LedgerEvent[],
): void {
    const failures = replayLedger(events).delegations.filter(
        (entry) => entry.failure !== null,
    );
    const waivers = new Map<string, string>();
    for (const waiver of result.failureWaivers) {
        if (waivers.has(waiver.delegationId)) {
            throw new OrchestrationDefectError(
                `Duplicate failure waiver for ${waiver.delegationId}`,
            );
        }
        waivers.set(waiver.delegationId, waiver.reason);
    }
    for (const entry of failures) {
        const reason = waivers.get(entry.id);
        const isDefect = entry.failure?.startsWith('orchestration_defect:');
        if (
            isDefect ||
            !mayIgnoreRoleFailure(entry.role, {
                workIsUnnecessary: reason !== undefined,
                reason,
            })
        ) {
            throw new OrchestrationDefectError(
                `Unresolved ${entry.role} delegation failure ${entry.id}: ${entry.failure}`,
                { taskId: entry.id },
            );
        }
        waivers.delete(entry.id);
    }
    if (waivers.size !== 0) {
        throw new OrchestrationDefectError(
            `Failure waiver does not identify a failed delegation: ${[
                ...waivers.keys(),
            ].join(', ')}`,
        );
    }
}

const COMMON_BRIEFING_SECTIONS = [
    'Objective',
    'Acceptance criteria',
    'Constraints',
    'Context and evidence',
    'Prior decisions and results',
    'Role task',
] as const;
const REVIEW_BRIEFING_SECTIONS = [
    'Plan',
    'Diff',
    'Validation report',
    'Known limitations and unresolved issues',
] as const;
const ALL_BRIEFING_SECTIONS = [
    ...COMMON_BRIEFING_SECTIONS,
    ...REVIEW_BRIEFING_SECTIONS,
];

/**
 * Reject context-poor handoffs at the application boundary. "None" is an
 * explicit value: omitting a section is never treated as an implicit answer.
 */
export function assertSelfContainedBriefing(
    role: SubagentRole,
    prompt: string,
    taskId?: string,
): void {
    const required =
        role === 'reviewer'
            ? [...COMMON_BRIEFING_SECTIONS, ...REVIEW_BRIEFING_SECTIONS]
            : COMMON_BRIEFING_SECTIONS;
    const sections = parseBriefingSections(prompt);
    const missing = required.filter((name) => !sections.get(name)?.trim());
    if (missing.length !== 0) {
        throw new OrchestrationDefectError(
            `Incomplete ${role} briefing; missing sections: ${missing.join(', ')}`,
            { taskId, missingSections: missing },
        );
    }
}

function parseBriefingSections(prompt: string): Map<string, string> {
    const sections = new Map<string, string>();
    const labels = new Set<string>(ALL_BRIEFING_SECTIONS);
    let current: string | undefined;
    for (const line of prompt.split(/\r?\n/u)) {
        const separator = line.indexOf(':');
        const candidate = separator < 0 ? '' : line.slice(0, separator).trim();
        if (labels.has(candidate)) {
            current = candidate;
            sections.set(current, line.slice(separator + 1).trim());
        } else if (current) {
            sections.set(
                current,
                `${sections.get(current) ?? ''}\n${line}`.trim(),
            );
        }
    }
    return sections;
}

interface DelegationIntent {
    id: string;
    role: SubagentRole;
    prompt: string;
}

export interface OrchestrationPolicyControllerOptions {
    conversationId: string;
    store: RunStore;
    runId: string;
    limits: OrchestrationLimits;
    patches?: PatchManager;
}

/**
 * Application boundary around Flue's model-driven task tool. It makes direct
 * task calls obey the same durable ledger, validation, budget, and role gates
 * as programmatic delegation.
 */
export class OrchestrationPolicyController {
    readonly conversationId: string;
    private readonly store: RunStore;
    private readonly runId: string;
    private readonly limits: OrchestrationLimits;
    private readonly intents = new Map<string, DelegationIntent>();
    private readonly boundary = new ReviewBoundary();
    private readonly patches?: PatchManager;

    constructor(options: OrchestrationPolicyControllerOptions) {
        this.conversationId = options.conversationId;
        this.store = options.store;
        this.runId = options.runId;
        this.limits = options.limits;
        this.patches = options.patches;
    }

    observe = (event: FlueObservation): void => {
        if (
            event.type !== 'task_start' ||
            event.instanceId !== this.conversationId
        )
            return;
        if (!isSubagentRole(event.agent)) {
            // Preserve the intent so the interceptor can fail it on-path.
            this.intents.set(event.taskId, {
                id: event.taskId,
                role: event.agent as SubagentRole,
                prompt: event.prompt,
            });
            return;
        }
        this.registerDelegation({
            id: event.taskId,
            role: event.agent,
            prompt: event.prompt,
        });
    };

    /** Public for deterministic adapters and tests that do not use observe(). */
    registerDelegation(intent: DelegationIntent): void {
        this.intents.set(intent.id, { ...intent });
    }

    intercept: FlueExecutionInterceptor = async <T>(
        operation: FlueExecutionOperation,
        context: FlueExecutionContext,
        next: () => Promise<T>,
    ): Promise<T> => {
        if (
            operation.type !== 'task' ||
            context.instanceId !== this.conversationId
        )
            return next();
        const intent = this.intents.get(operation.taskId);
        if (!intent) {
            throw new OrchestrationDefectError(
                `Delegation ${operation.taskId} has no recorded task intent`,
                { taskId: operation.taskId },
            );
        }
        if (!isSubagentRole(intent.role)) {
            throw new OrchestrationDefectError(
                `Delegation ${operation.taskId} selected an unauthorized role`,
                { taskId: operation.taskId },
            );
        }

        const run = () =>
            intent.role === 'implementer' || intent.role === 'reviewer'
                ? this.boundary.run(intent.role === 'implementer', () =>
                      this.execute(intent, next),
                  )
                : this.execute(intent, next);
        try {
            return await blockOnLimit(this.store, this.runId, () =>
                intent.role === 'implementer'
                    ? this.limits.runImplementer(run)
                    : this.limits.runReadOnly(run),
            );
        } finally {
            this.intents.delete(operation.taskId);
        }
    };

    private async execute<T>(
        intent: DelegationIntent,
        next: () => Promise<T>,
    ): Promise<T> {
        const append = (
            ledgerAction: Parameters<RunStore['update']>[1]['ledgerAction'],
        ) => this.store.update(this.runId, { ledgerAction });
        const capture = async () => {
            const latest = await this.patches?.latest(this.runId);
            return this.patches?.capture(this.runId, latest?.approvedNewFiles);
        };
        const before = await capture();
        if (intent.role === 'implementer') {
            const state = replayLedger(
                (await this.store.read(this.runId)).ledger,
            );
            const firstReview = state.delegations.findIndex(
                (entry) => entry.role === 'reviewer',
            );
            if (firstReview >= 0) {
                const repairs = state.delegations
                    .slice(firstReview)
                    .filter((entry) => entry.role === 'implementer').length;
                if (repairs >= 2) {
                    await this.store.update(this.runId, { status: 'blocked' });
                    throw new OrchestrationDefectError(
                        'Two repair cycles exhausted; unresolved review findings remain',
                    );
                }
                this.limits.consumeRepairCycle();
            }
        }
        await append({
            type: 'start',
            id: intent.id,
            parentId: null,
            role: intent.role,
            task: taskSummary(intent.prompt),
        });
        try {
            this.limits.consumeDelegation(intent.role);
            assertSelfContainedBriefing(intent.role, intent.prompt, intent.id);
            const outcome = await Promise.resolve()
                .then(next)
                .then(
                    (value) => ({ ok: true as const, value }),
                    (error: unknown) => ({ ok: false as const, error }),
                );
            // Snapshot even on failure; source contamination takes precedence.
            const after = await capture();
            if (
                intent.role === 'reviewer' &&
                before &&
                (after?.revisionHash !== before.revisionHash ||
                    after.sequence !== before.sequence)
            ) {
                await this.store.update(this.runId, { status: 'blocked' });
                throw new OrchestrationDefectError(
                    'Reviewer changed source; review invalidated',
                );
            }
            if (!outcome.ok) throw outcome.error;
            const output = outcome.value;
            const result = validateSubagentResult(
                intent.role,
                taskResponseText(output),
            );
            await append({ type: 'result', id: intent.id, result });
            return output;
        } catch (error) {
            if (error instanceof ResultValidationError) {
                await append({
                    type: 'malformed',
                    id: intent.id,
                    issues: error.issues.map(
                        (issue) => `${issue.path}: ${issue.message}`,
                    ),
                });
            }
            await append({
                type: 'failure',
                id: intent.id,
                message:
                    error instanceof OrchestrationDefectError
                        ? `orchestration_defect: ${error.message}`
                        : errorMessage(error),
            });
            throw error;
        }
    }
}

/** Install a controller for one root conversation; unrelated runs pass through. */
export function installOrchestrationPolicy(
    options: OrchestrationPolicyControllerOptions,
): () => Promise<void> {
    const controller = new OrchestrationPolicyController(options);
    return instrument({
        observe: controller.observe,
        interceptor: controller.intercept,
        dispose() {},
    });
}

function taskResponseText(output: unknown): unknown {
    if (
        typeof output === 'object' &&
        output !== null &&
        'text' in output &&
        typeof output.text === 'string'
    )
        return output.text;
    return output;
}

function taskSummary(prompt: string): string {
    return parseBriefingSections(prompt).get('Role task') ?? prompt;
}

function isSubagentRole(value: unknown): value is SubagentRole {
    return (
        typeof value === 'string' &&
        ['explorer', 'planner', 'implementer', 'reviewer'].includes(value)
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error
        ? error.message || error.name
        : String(error) || 'Unknown failure';
}
