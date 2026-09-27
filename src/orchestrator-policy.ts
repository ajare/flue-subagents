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
import { withEventOwner } from './event-owner.ts';
import { clearProviderStats, withProviderStats } from './provider-stats.ts';
import type { PatchManager } from './patch-publication.ts';
import { ReviewBoundary } from './review-gating.ts';
import { normalizeExplorerResult } from './subagents/explorer-result.ts';
import { AgentNames } from './agent-names.ts';
import { activeResultCorrection, ResultCorrection } from './result-correction.ts';

const text = v.pipe(v.string(), v.minLength(1));
export const orchestratorResultSchema = v.strictObject({
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
    readonly reasonCode?: 'incomplete_briefing' | 'unauthorized_role';
    readonly missingSections: readonly string[];

    constructor(
        message: string,
        options: {
            taskId?: string;
            reasonCode?: 'incomplete_briefing' | 'unauthorized_role';
            missingSections?: readonly string[];
            cause?: unknown;
        } = {},
    ) {
        super(message, { cause: options.cause });
        this.name = 'OrchestrationDefectError';
        this.taskId = options.taskId;
        this.reasonCode = options.reasonCode;
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
            // Tolerate presentation wrapping, not prose or partial JSON extraction.
            const trimmed = output.trim();
            const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(
                trimmed,
            );
            value = JSON.parse(fenced ? (fenced[1] as string) : trimmed);
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
const REQUIRED_COMMON_BRIEFING_SECTIONS = ['Objective', 'Role task'] as const;
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
 * Reject context-poor handoffs at the application boundary. Objective and role
 * task are always required (implementers may label the task "Changes to make").
 * Omitted optional context sections mean "None".
 */
export function assertSelfContainedBriefing(
    role: SubagentRole,
    prompt: string,
    taskId?: string,
): void {
    const required =
        role === 'reviewer'
            ? [
                  ...REQUIRED_COMMON_BRIEFING_SECTIONS,
                  ...REVIEW_BRIEFING_SECTIONS,
              ]
            : REQUIRED_COMMON_BRIEFING_SECTIONS;
    const sections = parseBriefingSections(prompt, role);
    const missing = required.filter((name) => !sections.get(name)?.trim());
    if (missing.length !== 0) {
        throw new OrchestrationDefectError(
            `Incomplete ${role} briefing; missing sections: ${missing.join(', ')}`,
            { taskId, reasonCode: 'incomplete_briefing', missingSections: missing },
        );
    }
}

function parseBriefingSections(
    prompt: string,
    role: SubagentRole,
): Map<string, string> {
    const sections = new Map<string, string>();
    const labels = new Set<string>(ALL_BRIEFING_SECTIONS);
    let current: string | undefined;
    let level = 0;
    let fence: string | undefined;
    for (const line of prompt.split(/\r?\n/u)) {
        // Code examples are section content, never briefing headings.
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        const inCode = fence !== undefined || marker !== null;
        if (marker) {
            if (!fence) fence = marker[1];
            else if (
                marker[1]?.[0] === fence[0] &&
                marker[1].length >= fence.length &&
                !marker[2]?.trim()
            )
                fence = undefined;
        }
        if (!inCode) {
            const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
            const text = heading?.[2] ?? line;
            const separator = text.indexOf(':');
            let candidate =
                separator < 0
                    ? heading
                        ? text.trim()
                        : ''
                    : text.slice(0, separator).trim();
            // The historical implementer briefing used this explicit task
            // section instead of the canonical Role task label.
            if (role === 'implementer' && candidate === 'Changes to make') {
                candidate = 'Role task';
            }
            if (labels.has(candidate)) {
                current = candidate;
                level = heading?.[1]?.length ?? 0;
                sections.set(
                    current,
                    separator < 0 ? '' : text.slice(separator + 1).trim(),
                );
                continue;
            }
            // Keep nested task subsections, but exclude sibling sections such
            // as Constraints and Verification from the ledger task summary.
            if (heading && (heading[1]?.length ?? 0) <= level)
                current = undefined;
        }
        if (current) {
            sections.set(current, `${sections.get(current) ?? ''}\n${line}`);
        }
    }
    return new Map(
        [...sections].map(([name, content]) => [name, content.trim()]),
    );
}

/** Pure preflight, shared with telemetry so observer ordering cannot allocate names. */
export function preflightDelegation(role: unknown, prompt: string, taskId?: string): void {
    if (!isSubagentRole(role)) {
        throw new OrchestrationDefectError('Delegation selected an unauthorized role', { taskId, reasonCode: 'unauthorized_role' });
    }
    assertSelfContainedBriefing(role, prompt, taskId);
}

export function delegationRejection(role: unknown, prompt: string) {
    try {
        preflightDelegation(role, prompt);
        return null;
    } catch (error) {
        if (!(error instanceof OrchestrationDefectError)) throw error;
        return {
            role: isSubagentRole(role) ? role : 'unknown',
            reasonCode: error.reasonCode,
            message: error.message,
            missingSections: [...error.missingSections],
        };
    }
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
    agentNames?: AgentNames;
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
    private readonly agentNames: AgentNames;
    private readonly patches?: PatchManager;

    constructor(options: OrchestrationPolicyControllerOptions) {
        this.conversationId = options.conversationId;
        this.store = options.store;
        this.runId = options.runId;
        this.limits = options.limits;
        this.patches = options.patches;
        this.agentNames = options.agentNames ?? new AgentNames();
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
        if (operation.type === 'model' && context.instanceId === this.conversationId) {
            return withProviderStats(operation.turnId, this.conversationId, next);
        }
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
        // Reject tool input before names, budgets, gates, patch capture or ledger writes.
        // Remove the intent even on preflight failure; a retry is a new task call.
        this.intents.delete(operation.taskId);
        preflightDelegation(intent.role, intent.prompt, intent.id);

        const run = () =>
            intent.role === 'implementer' || intent.role === 'reviewer'
                ? this.boundary.run(intent.role === 'implementer', () =>
                      this.execute(intent, next),
                  )
                : this.execute(intent, next);
        try {
            return await withEventOwner(
                { agent: this.agentNames.get(intent.id, intent.role), taskId: intent.id },
                () => blockOnLimit(this.store, this.runId, () =>
                    intent.role === 'implementer'
                        ? this.limits.runImplementer(run)
                        : this.limits.runReadOnly(run),
                ),
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
            task: taskSummary(intent.prompt, intent.role),
        });
        const correction = new ResultCorrection(intent.role, {
            prompt: intent.prompt,
            consume: () => this.limits.consumeDelegation(intent.role),
            onMalformed: async (error) => {
                await append({ type: 'malformed', id: intent.id, issues: error.issues.map(issue => `${issue.path}: ${issue.message}`) });
            },
            onRetry: async () => { await append({ type: 'retry', id: intent.id }); },
            validate: output => intent.role === 'explorer' ? normalizeExplorerResult(output) : validateSubagentResult(intent.role, output),
        });
        try {
            this.limits.consumeDelegation(intent.role);
            const outcome = await Promise.resolve()
                .then(() => activeResultCorrection.run(correction, next))
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
            if (correction.failure) throw correction.failure;
            const result = correction.result ?? (
                intent.role === 'explorer'
                    ? normalizeExplorerResult(taskResponseText(output))
                    : validateSubagentResult(intent.role, taskResponseText(output)));
            await append({ type: 'result', id: intent.id, result });
            if (correction.result || intent.role === 'explorer') {
                // Flue forwards this text as the task tool result. Do not send
                // the unvalidated presentation back to the orchestrator.
                const text = JSON.stringify(result);
                return (
                    typeof output === 'object' && output !== null && 'text' in output
                        ? { ...output, text }
                        : typeof output === 'string'
                          ? text
                          : result
                ) as T;
            }
            return output;
        } catch (error) {
            if (error instanceof ResultValidationError && error !== correction.failure) {
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
        dispose() { clearProviderStats(options.conversationId); },
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

function taskSummary(prompt: string, role: SubagentRole): string {
    return parseBriefingSections(prompt, role).get('Role task') ?? prompt;
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
