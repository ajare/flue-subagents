import * as v from 'valibot';
import {
    validateSubagentResult,
    type SubagentResult,
    type SubagentRole,
} from './result-contracts.ts';

const text = v.pipe(v.string(), v.minLength(1));
const patchSchema = v.strictObject({ revisionHash: text, diffHash: text });
export type PatchIdentity = v.InferOutput<typeof patchSchema>;
const actionSchema = v.variant('type', [
    v.strictObject({ type: v.literal('patch'), patch: patchSchema }),
    v.strictObject({
        type: v.literal('start'),
        id: text,
        role: v.picklist(['explorer', 'planner', 'implementer', 'reviewer']),
        task: text,
        parentId: v.nullable(text),
    }),
    v.strictObject({
        type: v.literal('malformed'),
        id: text,
        issues: v.array(text),
    }),
    v.strictObject({ type: v.literal('retry'), id: text }),
    v.strictObject({
        type: v.literal('result'),
        id: text,
        result: v.unknown(),
    }),
    v.strictObject({ type: v.literal('failure'), id: text, message: text }),
]);
export type LedgerAction = v.InferOutput<typeof actionSchema>;
export interface LedgerEvent {
    sequence: number;
    /** New records use epoch milliseconds; ISO strings are legacy records. */
    at: number | string;
    agent?: string;
    taskId?: string;
    action: LedgerAction;
}
export interface DelegationEntry {
    id: string;
    sequence: number;
    role: SubagentRole;
    task: string;
    parentId: string | null;
    startedAt: string;
    completedAt: string | null;
    patchBefore: PatchIdentity | null;
    patchAfter: PatchIdentity | null;
    /** Epoch prevents an A -> B -> A mutation from reviving an old approval. */
    patchEpoch: number;
    malformedResults: { at: string; issues: string[] }[];
    retries: number;
    result: SubagentResult | null;
    failure: string | null;
}
export interface LedgerState {
    patch: PatchIdentity | null;
    patchEpoch: number;
    delegations: DelegationEntry[];
}
const eventsSchema = v.array(
    v.strictObject({
        sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
        at: v.union([
            v.pipe(v.number(), v.integer(), v.check((value) => Number.isFinite(new Date(value).getTime()))),
            v.pipe(text, v.check((value) => Number.isFinite(Date.parse(value)))),
        ]),
        agent: v.optional(text),
        taskId: v.optional(text),
        action: actionSchema,
    }),
);

/** Replay validates both the document and lifecycle invariants; never trust stored prose. */
export function replayLedger(input: unknown): LedgerState {
    const events = v.parse(eventsSchema, input);
    const state: LedgerState = { patch: null, patchEpoch: 0, delegations: [] };
    const entries = new Map<string, DelegationEntry>();
    let previousTime = -Infinity;
    for (const [index, event] of events.entries()) {
        const time = typeof event.at === 'number' ? event.at : Date.parse(event.at);
        const at = new Date(time).toISOString();
        if (event.sequence !== index + 1 || time < previousTime)
            throw new Error('Invalid ledger event order');
        previousTime = time;
        const action = event.action;
        if (action.type === 'patch') {
            if (
                state.patch?.revisionHash === action.patch.revisionHash &&
                state.patch.diffHash === action.patch.diffHash
            )
                continue;
            state.patch = action.patch;
            state.patchEpoch += 1;
            continue;
        }
        if (action.type === 'start') {
            if (entries.has(action.id))
                throw new Error('Duplicate delegation id');
            if (action.parentId !== null) {
                const parent = entries.get(action.parentId);
                if (!parent || parent.completedAt !== null)
                    throw new Error('Parent delegation must be active');
            }
            if (action.role === 'reviewer' && !state.patch)
                throw new Error('Review requires a captured patch');
            const entry: DelegationEntry = {
                ...action,
                sequence: event.sequence,
                startedAt: at,
                completedAt: null,
                patchBefore: state.patch,
                patchAfter: null,
                patchEpoch: state.patchEpoch,
                malformedResults: [],
                retries: 0,
                result: null,
                failure: null,
            };
            entries.set(action.id, entry);
            state.delegations.push(entry);
            continue;
        }
        const entry = entries.get(action.id);
        if (!entry || entry.completedAt !== null)
            throw new Error('Delegation must be active');
        if (action.type === 'malformed') {
            entry.malformedResults.push({
                at,
                issues: action.issues,
            });
        } else if (action.type === 'retry') {
            if (entry.retries !== 0 || entry.malformedResults.length !== 1)
                throw new Error('Only one malformed-result retry is permitted');
            entry.retries += 1;
        } else {
            if (action.type === 'result') {
                entry.result = validateSubagentResult(
                    entry.role,
                    action.result,
                );
            } else entry.failure = action.message;
            entry.completedAt = at;
            entry.patchAfter = state.patch;
        }
    }
    return state;
}

/** Conservative eligibility; policy may add further budget/validation requirements. */
export function completionEligibility(events: readonly LedgerEvent[]): {
    eligible: boolean;
    reasons: string[];
    approvalId: string | null;
    warnings: string[];
} {
    const state = replayLedger(events);
    const reasons: string[] = [];
    if (!state.patch) reasons.push('No captured patch');
    if (state.delegations.some((entry) => entry.completedAt === null))
        reasons.push('Delegations are still active');
    if (state.delegations.some((entry) => entry.failure !== null))
        reasons.push('Unresolved delegation failures');
    const reviews = state.delegations.filter(
        (entry) =>
            entry.role === 'reviewer' &&
            entry.patchEpoch === state.patchEpoch &&
            entry.patchBefore?.diffHash === state.patch?.diffHash &&
            entry.patchAfter?.revisionHash === state.patch?.revisionHash &&
            entry.result,
    );
    const review = reviews.at(-1);
    const warnings: string[] = [];
    const approvals = reviews.map((entry) => {
        const review = entry.result;
        if (review?.role !== 'reviewer') return false;
        warnings.push(...review.limitations);
        warnings.push(
            ...review.findings
                .filter((finding) => finding.severity === 'warning')
                .map((finding) => finding.description),
        );
        if (
            review.verdict === 'blocked' ||
            review.verdict === 'changes_requested'
        ) {
            reasons.push(
                `${entry.id}: ${review.verdict}: ${review.summary}`,
                ...review.findings.map((finding) => finding.description),
            );
            return false;
        }
        reasons.push(
            ...review.findings
                .filter((finding) => finding.severity === 'blocking')
                .map((finding) => `${entry.id}: ${finding.description}`),
        );
        const missing = review.validation.filter(
            (check) => check.result !== 'passed',
        );
        if (missing.some((check) => check.scope !== 'optional')) {
            reasons.push(
                `${entry.id}: Central behavior has not been validated`,
            );
            return false;
        }
        return (
            !review.findings.some(
                (finding) => finding.severity === 'blocking',
            ) &&
            (missing.length === 0 ||
                (review.verdict === 'approved_with_limitations' &&
                    review.limitations.length > 0)) &&
            (review.verdict !== 'approved_with_limitations' ||
                review.limitations.length > 0)
        );
    });
    const approved = approvals.length > 0 && approvals.every(Boolean);
    if (!approved) reasons.push('No current review approval');
    return {
        eligible: reasons.length === 0,
        reasons,
        approvalId: approved && review ? review.id : null,
        warnings: [...new Set(warnings)],
    };
}

export function freezeLedger(events: LedgerEvent[]): void {
    function freeze(value: unknown): void {
        if (value && typeof value === 'object') {
            for (const child of Object.values(value)) freeze(child);
            Object.freeze(value);
        }
    }
    freeze(events);
}
