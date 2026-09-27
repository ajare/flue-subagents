import * as v from 'valibot';
import { ResultCorrection } from './result-correction.ts';

export const RESULT_CONTRACT_VERSION = 1 as const;

export type SubagentRole = 'explorer' | 'planner' | 'implementer' | 'reviewer';
export type ReviewerVerdict =
    | 'approved'
    | 'approved_with_limitations'
    | 'changes_requested'
    | 'blocked';

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const stringList = v.array(nonEmptyString);
const contractHeader = {
    schemaVersion: v.literal(RESULT_CONTRACT_VERSION),
};

export const explorerResultSchema = v.strictObject({
    ...contractHeader,
    role: v.literal('explorer'),
    summary: nonEmptyString,
    findings: stringList,
    evidence: v.array(
        v.strictObject({
            path: nonEmptyString,
            line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
            symbol: v.optional(nonEmptyString),
            observation: nonEmptyString,
        }),
    ),
    openQuestions: stringList,
});

export const plannerResultSchema = v.strictObject({
    ...contractHeader,
    role: v.literal('planner'),
    summary: nonEmptyString,
    steps: v.pipe(
        v.array(
            v.strictObject({
                description: nonEmptyString,
                affectedFiles: stringList,
                affectedSymbols: stringList,
            }),
        ),
        v.minLength(1),
    ),
    tests: stringList,
    risks: stringList,
});

const commandResultSchema = v.strictObject({
    command: nonEmptyString,
    scope: v.optional(v.picklist(['central', 'optional'])),
    result: v.picklist(['passed', 'failed', 'not_run']),
    exitCode: v.nullable(v.pipe(v.number(), v.integer())),
    summary: nonEmptyString,
});

export const implementerResultSchema = v.strictObject({
    ...contractHeader,
    role: v.literal('implementer'),
    summary: nonEmptyString,
    changes: v.array(
        v.strictObject({
            path: nonEmptyString,
            summary: nonEmptyString,
        }),
    ),
    commands: v.array(commandResultSchema),
    unresolvedIssues: stringList,
});

export const reviewerResultSchema = v.strictObject({
    ...contractHeader,
    role: v.literal('reviewer'),
    verdict: v.picklist([
        'approved',
        'approved_with_limitations',
        'changes_requested',
        'blocked',
    ]),
    summary: nonEmptyString,
    findings: v.array(
        v.strictObject({
            severity: v.picklist(['blocking', 'warning', 'note']),
            description: nonEmptyString,
            path: v.optional(nonEmptyString),
            line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        }),
    ),
    validation: v.array(commandResultSchema),
    limitations: stringList,
});

export type ExplorerResult = v.InferOutput<typeof explorerResultSchema>;
export type PlannerResult = v.InferOutput<typeof plannerResultSchema>;
export type ImplementerResult = v.InferOutput<typeof implementerResultSchema>;
export type ReviewerResult = v.InferOutput<typeof reviewerResultSchema>;
export type SubagentResult =
    | ExplorerResult
    | PlannerResult
    | ImplementerResult
    | ReviewerResult;

export const resultSchemas = {
    explorer: explorerResultSchema,
    planner: plannerResultSchema,
    implementer: implementerResultSchema,
    reviewer: reviewerResultSchema,
} as const;

export type ResultForRole<Role extends SubagentRole> = {
    explorer: ExplorerResult;
    planner: PlannerResult;
    implementer: ImplementerResult;
    reviewer: ReviewerResult;
}[Role];

export interface ResultValidationIssue {
    path: string;
    message: string;
}

export interface ResultDiagnostics {
    reasonCode: 'output_truncated' | 'invalid_subagent_result';
    stopReason?: 'length';
    configuredOutputTokenLimit?: number;
    outputTokens?: number;
    reachedValidation: boolean;
}

export interface ResultSizeLimits {
    maxStringLength: number;
    maxCollectionItems: number;
    maxResultLength: number;
}

export const DEFAULT_RESULT_LIMITS: Record<SubagentRole, ResultSizeLimits> = {
    explorer: { maxStringLength: 4000, maxCollectionItems: 128, maxResultLength: 48000 },
    planner: { maxStringLength: 4000, maxCollectionItems: 64, maxResultLength: 32000 },
    implementer: { maxStringLength: 4000, maxCollectionItems: 128, maxResultLength: 48000 },
    reviewer: { maxStringLength: 4000, maxCollectionItems: 128, maxResultLength: 48000 },
};

export const CONCISE_RESULT_POLICY = `
RESULT SIZE POLICY
Use one evidence item per distinct fact, not per grep hit. Group caller locations
with identical observations. Keep excerpts centered on the relevant expression.
Do not reproduce full files, command output, repeated issue bodies, or narrative
already represented in evidence unless verbatim content is the objective.
Summaries should point to evidence, not duplicate it. Target at most one quarter
of the configured output-token budget for the final object, leaving room for reasoning.
If asked to compact, preserve conclusions and unique evidence; shorten and deduplicate.
`;

export class ResultValidationError extends Error {
    diagnostics?: ResultDiagnostics;
    get code() { return this.diagnostics?.reasonCode ?? 'invalid_subagent_result'; }
    readonly role: SubagentRole;
    readonly issues: readonly ResultValidationIssue[];
    readonly output: unknown;

    constructor(
        role: SubagentRole,
        issues: readonly ResultValidationIssue[],
        output: unknown,
        options?: ErrorOptions,
    ) {
        super(
            `Invalid ${role} result: ${issues.map(formatIssue).join('; ')}`,
            options,
        );
        this.name = 'ResultValidationError';
        this.role = role;
        this.issues = Object.freeze([...issues]);
        this.output = output;
    }
}

/** Parse and validate a persisted object or a subagent's JSON response. */
export function validateSubagentResult<Role extends SubagentRole>(
    role: Role,
    output: unknown,
    limits: ResultSizeLimits = DEFAULT_RESULT_LIMITS[role],
): ResultForRole<Role> {
    let value = output;
    if (typeof output === 'string') {
        try {
            value = JSON.parse(output);
        } catch (cause) {
            throw new ResultValidationError(
                role,
                [{ path: '$', message: 'must be valid JSON' }],
                output,
                { cause },
            );
        }
    }

    if (role === 'reviewer' && value && typeof value === 'object' && 'findings' in value && Array.isArray(value.findings)) {
        value = { ...value, findings: value.findings.map(finding => {
            if (!finding || typeof finding !== 'object') return finding;
            const normalized = { ...finding };
            for (const key of ['path', 'line']) if (normalized[key] === null) delete normalized[key];
            return normalized;
        }) };
    }

    // The role-specific lookup makes the runtime check discriminated while the
    // generic return type preserves the role/result relationship for callers.
    const parsed = v.safeParse(resultSchemas[role], value);
    if (!parsed.success) {
        throw new ResultValidationError(
            role,
            parsed.issues.map((issue) => ({
                path: issuePath(issue),
                message: issue.message.replace(/received (?!undefined\b)[\s\S]*/u, 'received invalid value'),
            })),
            output,
        );
    }
    const issues: ResultValidationIssue[] = [];
    function check(value: unknown, path: string): void {
        if (typeof value === 'string' && value.length > limits.maxStringLength)
            issues.push({ path, message: `compact to at most ${limits.maxStringLength} characters` });
        if (Array.isArray(value)) {
            if (value.length > limits.maxCollectionItems)
                issues.push({ path, message: `group and deduplicate to at most ${limits.maxCollectionItems} items` });
            value.forEach((item, index) => { check(item, `${path}[${index}]`); });
        } else if (value && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) {
                // Fixed contract discriminants cannot be shortened by the model.
                if (!['role', 'verdict', 'scope', 'result', 'severity'].includes(key)) check(item, `${path}.${key}`);
            }
        }
    }
    check(parsed.output, '$');
    if (JSON.stringify(parsed.output).length > limits.maxResultLength)
        issues.push({ path: '$', message: `compact the complete object to at most ${limits.maxResultLength} characters` });
    if (issues.length) throw new ResultValidationError(role, issues, output);
    return parsed.output as ResultForRole<Role>;
}

export interface DelegationBudget {
    consume(role: SubagentRole): void;
}

export class DelegationBudgetExceededError extends Error {
    readonly code = 'delegation_budget_exceeded';
    readonly limit: number;

    constructor(limit: number) {
        super(`Delegation budget of ${limit} has been exhausted`);
        this.name = 'DelegationBudgetExceededError';
        this.limit = limit;
    }
}

/** A small shared counter; both the first call and corrective retry consume it. */
export function createDelegationBudget(
    limit: number,
    initiallyUsed = 0,
): DelegationBudget & {
    readonly used: number;
    readonly remaining: number;
} {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TypeError(
            'Delegation budget limit must be a positive integer',
        );
    }
    if (
        !Number.isSafeInteger(initiallyUsed) ||
        initiallyUsed < 0 ||
        initiallyUsed > limit
    ) {
        throw new TypeError(
            'Initially used delegation budget must be between zero and the limit',
        );
    }
    let used = initiallyUsed;
    return {
        get used() {
            return used;
        },
        get remaining() {
            return limit - used;
        },
        consume() {
            if (used >= limit) throw new DelegationBudgetExceededError(limit);
            used += 1;
        },
    };
}

export interface CorrectableDelegationOptions<Role extends SubagentRole> {
    role: Role;
    prompt: string;
    budget: DelegationBudget;
    onMalformed?: (error: ResultValidationError) => void | Promise<void>;
    delegate: (
        prompt: string,
        context: Readonly<{ attempt: 1 | 2; corrective: boolean }>,
    ) => unknown | Promise<unknown>;
}

/**
 * Validate a delegation result and make at most one corrective delegation.
 * A second malformed response is terminal for every role.
 */
export async function delegateWithValidatedResult<Role extends SubagentRole>(
    options: CorrectableDelegationOptions<Role>,
): Promise<ResultForRole<Role>> {
    const correction = new ResultCorrection(options.role, {
        prompt: options.prompt,
        consume: () => options.budget.consume(options.role),
        onMalformed: options.onMalformed,
    });
    options.budget.consume(options.role);
    const first = await options.delegate(options.prompt, { attempt: 1, corrective: false });
    const prompt = await correction.submit(first);
    if (prompt) await correction.submit(await options.delegate(prompt, { attempt: 2, corrective: true }));
    return correction.result as ResultForRole<Role>;
}

/** The only roles whose failed work may be declared unnecessary. */
export function mayIgnoreRoleFailure(
    role: SubagentRole,
    determination: { workIsUnnecessary: boolean; reason?: string },
): boolean {
    return (
        (role === 'explorer' || role === 'planner') &&
        determination.workIsUnnecessary === true &&
        typeof determination.reason === 'string' &&
        determination.reason.trim().length > 0
    );
}

export function correctivePrompt(
    role: SubagentRole,
    error: ResultValidationError,
    originalPrompt?: string,
): string {
    if (error.diagnostics?.reasonCode === 'output_truncated') {
        return `Your result was truncated at the output-token limit and is invalid. Return only one compact JSON object matching the original OUTPUT CONTRACT, using submit_specialist_result. Preserve conclusions and unique evidence, deduplicate callers, shorten excerpts to the minimum needed, and omit narrative already represented by evidence entries. Target less than half the previous result size. Retain your investigation; do not rerun repository commands unless necessary. This is your only corrective attempt.`;
    }
    const problems = error.issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join('\n');
    const task = originalPrompt ? `\nOriginal task:\n${originalPrompt}\n` : '';
    return `Your previous ${role} result did not satisfy result contract version ${RESULT_CONTRACT_VERSION}.
Repair only the result object; retain your investigation and do not repeat work.
Follow the original OUTPUT CONTRACT in your system instructions, including required semantic fields.
Return only one corrected JSON object (using submit_specialist_result when available). Do not include Markdown fences or commentary.
${task}
Validation errors:
${problems}

Previous output:
${displayOutput(error.output)}`;
}

function displayOutput(output: unknown): string {
    if (typeof output === 'string') return output;
    try {
        return JSON.stringify(output);
    } catch {
        return String(output);
    }
}

const contractKeys = new Set([
    'schemaVersion', 'role', 'summary', 'findings', 'evidence', 'path', 'line',
    'symbol', 'observation', 'openQuestions', 'steps', 'description',
    'affectedFiles', 'affectedSymbols', 'tests', 'risks', 'changes', 'commands',
    'command', 'scope', 'result', 'exitCode', 'unresolvedIssues', 'verdict',
    'severity', 'validation', 'limitations',
]);

function issuePath(issue: v.BaseIssue<unknown>): string {
    if (!issue.path || issue.path.length === 0) return '$';
    return issue.path.reduce((path, item) => {
        const key = item.key;
        return typeof key === 'number'
            ? `${path}[${key}]`
            : `${path}.${contractKeys.has(String(key)) ? String(key) : '<unknown-field>'}`;
    }, '$');
}

function formatIssue(issue: ResultValidationIssue): string {
    return `${issue.path} ${issue.message}`;
}
