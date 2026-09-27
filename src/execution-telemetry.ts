import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { type FlueObservation, observe } from '@flue/runtime';
import { takeProviderStats } from './provider-stats.ts';
import { AgentNames } from './agent-names.ts';
import { delegationRejection } from './orchestrator-policy.ts';

interface Span {
    startedAt: string;
    outputTokens: number;
    usageComplete: boolean;
    agent?: string;
}

/** Content-free, append-only telemetry. Each dispatch gets its own prompt ID. */
export class ExecutionTelemetry {
    readonly promptId = randomUUID();
    private tasks = new Map<string, Span>();
    private turns = new Map<string, Span>();

    private path: string;
    private runId: string;
    private conversationId: string;
    private onEvent?: (event: object) => void;
    private maxOutputTokens: number;
    private contextWindow: number;
    private readonly agentNames: AgentNames;

    constructor(
        path: string,
        runId: string,
        conversationId: string,
        maxOutputTokens: number,
        contextWindow: number,
        onEvent?: (event: object) => void,
        agentNames = new AgentNames(),
    ) {
        this.agentNames = agentNames;
        if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
            throw new RangeError('maxOutputTokens must be a positive integer');
        }
        if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
            throw new RangeError('contextWindow must be a positive integer');
        }
        this.contextWindow = contextWindow;
        this.maxOutputTokens = maxOutputTokens;
        this.onEvent = onEvent;
        this.path = path;
        this.runId = runId;
        this.conversationId = conversationId;
        this.record({
            type: 'prompt_start',
            timestamp: new Date().toISOString(),
        });
    }

    private record(event: object) {
        appendFileSync(
            this.path,
            `${JSON.stringify({ schemaVersion: 1, runId: this.runId, promptId: this.promptId, ...event })}\n`,
            { mode: 0o600 },
        );
    }

    observe = (event: FlueObservation): void => {
        if (event.instanceId !== this.conversationId) return;
        if (event.type === 'turn_request') {
            this.record({
                type: 'llm_start',
                ts: Date.parse(event.timestamp),
                turnId: event.turnId,
                taskId: event.taskId,
                agent: event.taskId ? this.tasks.get(event.taskId)?.agent ?? 'unknown' : 'orchestrator',
            });
        }
        if (event.type === 'task_start') {
            const rejection = delegationRejection(event.agent, event.prompt);
            if (rejection) {
                const output = {
                    type: 'event',
                    event: 'delegation_rejected',
                    runId: this.runId,
                    promptId: this.promptId,
                    ts: Date.parse(event.timestamp),
                    agent: 'orchestrator',
                    taskId: event.taskId,
                    ...rejection,
                };
                this.record(output);
                this.onEvent?.(output);
                return;
            }
            this.tasks.set(event.taskId, {
                startedAt: event.timestamp,
                outputTokens: 0,
                usageComplete: true,
                agent: this.agentNames.get(event.taskId, event.agent),
            });
            this.record({
                type: 'subagent_start',
                taskId: event.taskId,
                agent: this.agentNames.get(event.taskId, event.agent),
                startedAt: event.timestamp,
            });
        } else if (event.type === 'turn_request' && !event.taskId) {
            this.turns.set(event.turnId, {
                startedAt: event.timestamp,
                outputTokens: 0,
                usageComplete: true,
            });
            this.record({
                type: 'orchestrator_llm_start',
                turnId: event.turnId,
                startedAt: event.timestamp,
                model: event.request.requestedModel,
                purpose: event.purpose,
            });
        } else if (event.type === 'turn') {
            const tokens = event.response.usage?.output;
            const stats = takeProviderStats(event.turnId);
            const usage = event.response.usage;
            // Runtime input excludes cache reads/writes; include them to report
            // the complete input context, not just newly processed tokens.
            const reportedPrompt = stats.usage?.prompt_tokens;
            const inputTokens = typeof reportedPrompt === 'number'
                ? reportedPrompt
                : usage
                    ? usage.input + usage.cacheRead + usage.cacheWrite
                    : undefined;
            const contextTokens = typeof inputTokens === 'number' &&
                Number.isFinite(inputTokens) && inputTokens >= 0
                ? inputTokens
                : null;
            const output = {
                type: 'event',
                event: 'llm_output',
                runId: this.runId,
                promptId: this.promptId,
                ts: Date.parse(event.timestamp),
                agent: event.taskId
                    ? this.tasks.get(event.taskId)?.agent ?? 'unknown'
                    : 'orchestrator',
                taskId: event.taskId,
                turnId: event.turnId,
                ...stats,
                contextTokens,
                contextWindow: this.contextWindow,
                contextUtilization: contextTokens === null
                    ? null
                    : Math.max(0, Math.min(1, contextTokens / this.contextWindow)),
                outputTokens: tokens ?? null,
                outputTokenPercentage: tokens === undefined
                    ? null
                    : Math.max(0, Math.min(1, tokens / this.maxOutputTokens)),
                status: event.isError ? 'failed' : 'completed',
            };
            this.record(output);
            this.onEvent?.(output);
            if (event.taskId) {
                const task = this.tasks.get(event.taskId);
                if (task) {
                    task.outputTokens += tokens ?? 0;
                    task.usageComplete &&= tokens !== undefined;
                }
            } else {
                const span = this.turns.get(event.turnId);
                this.record({
                    type: 'orchestrator_llm_end',
                    turnId: event.turnId,
                    startedAt: span?.startedAt,
                    endedAt: event.timestamp,
                    outputTokens: tokens ?? null,
                    status: event.isError ? 'failed' : 'completed',
                });
                this.turns.delete(event.turnId);
            }
        } else if (event.type === 'task') {
            const span = this.tasks.get(event.taskId);
            // Rejected task-tool input never started a specialist span.
            if (!span) return;
            const failure = event.isError ? {
                reasonCode: 'specialist_execution_failed',
                message: 'Specialist execution failed.',
            } : {};
            if (event.isError) {
                const output = {
                    type: 'event',
                    event: 'delegation_failed',
                    runId: this.runId,
                    promptId: this.promptId,
                    ts: Date.parse(event.timestamp),
                    taskId: event.taskId,
                    agent: span.agent,
                    ...failure,
                };
                // Runtime result/error text may contain private model or command output.
                this.record(output);
                this.onEvent?.(output);
            }
            this.record({
                type: 'subagent_end',
                taskId: event.taskId,
                agent: this.agentNames.get(event.taskId, event.agent),
                ...span,
                startedAt:
                    span?.startedAt ??
                    new Date(
                        Date.parse(event.timestamp) - event.durationMs,
                    ).toISOString(),
                outputTokens: span?.outputTokens ?? null,
                usageComplete: span?.usageComplete ?? false,
                endedAt: event.timestamp,
                status: event.isError ? 'failed' : 'completed',
                ...failure,
            });
            this.tasks.delete(event.taskId);
        }
    };

    finish(status: 'completed' | 'interrupted') {
        const endedAt = new Date().toISOString();
        for (const [taskId, span] of this.tasks)
            this.record({
                type: 'subagent_end',
                taskId,
                ...span,
                usageComplete: false,
                endedAt,
                status: 'interrupted',
            });
        for (const [turnId, span] of this.turns)
            this.record({
                type: 'orchestrator_llm_end',
                turnId,
                startedAt: span.startedAt,
                endedAt,
                outputTokens: null,
                status: 'interrupted',
            });
        this.record({ type: 'prompt_end', timestamp: endedAt, status });
        this.tasks.clear();
        this.turns.clear();
    }
}

export async function recordPrompt<T>(
    path: string,
    runId: string,
    conversationId: string,
    execute: () => Promise<T>,
    maxOutputTokens: number,
    contextWindow: number,
    onEvent?: (event: object) => void,
    agentNames?: AgentNames,
): Promise<T> {
    const telemetry = new ExecutionTelemetry(path, runId, conversationId, maxOutputTokens, contextWindow, onEvent, agentNames);
    const unsubscribe = observe(telemetry.observe);
    let status: 'completed' | 'interrupted' = 'interrupted';
    try {
        const result = await execute();
        status = 'completed';
        return result;
    } finally {
        unsubscribe();
        telemetry.finish(status);
    }
}
