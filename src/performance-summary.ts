import { readFile } from 'node:fs/promises';

export interface AgentPerformance {
    agent: string;
    llmCalls: number;
    measuredCalls: number;
    generatedTokens: number;
    generationMs: number;
    averageTokensPerSecond: number | null;
}

/** Aggregate only per-turn records, never duplicate subagent/prompt totals. */
export function summarizePerformance(
    events: Record<string, unknown>[],
): AgentPerformance[] {
    const agents = new Map<string, AgentPerformance>();
    const seen = new Set<string>();
    const counted = new Set<string>();
    const get = (agent: string) => {
        let row = agents.get(agent);
        if (!row) {
            row = {
                agent,
                llmCalls: 0,
                measuredCalls: 0,
                generatedTokens: 0,
                generationMs: 0,
                averageTokensPerSecond: null,
            };
            agents.set(agent, row);
        }
        return row;
    };
    for (const event of events) {
        if (event.type === 'prompt_start') get('orchestrator');
        if (event.type === 'subagent_start' && typeof event.agent === 'string')
            get(event.agent);
        if (
            (event.event !== 'llm_output' && event.type !== 'llm_start') ||
            typeof event.agent !== 'string'
        )
            continue;
        const row = get(event.agent);
        const key =
            typeof event.turnId === 'string'
                ? JSON.stringify([event.promptId, event.turnId])
                : undefined;
        if (key === undefined || !counted.has(key)) {
            row.llmCalls++;
            if (key !== undefined) counted.add(key);
        }
        if (event.type === 'llm_start') continue;
        if (key !== undefined) {
            if (seen.has(key)) continue;
            seen.add(key);
        }
        const timings = event.timings as Record<string, unknown> | undefined;
        const tokens = timings?.predicted_n;
        const ms = timings?.predicted_ms;
        // Use the provider's matching numerator and denominator, including
        // reasoning tokens. Never divide by run wall time or average rates.
        if (
            typeof tokens === 'number' &&
            Number.isFinite(tokens) &&
            tokens >= 0 &&
            typeof ms === 'number' &&
            Number.isFinite(ms) &&
            ms > 0
        ) {
            row.measuredCalls++;
            row.generatedTokens += tokens;
            row.generationMs += ms;
        }
    }
    for (const row of agents.values()) {
        if (
            row.llmCalls > 0 &&
            row.measuredCalls === row.llmCalls &&
            row.generationMs > 0
        ) {
            row.averageTokensPerSecond =
                (row.generatedTokens * 1000) / row.generationMs;
        }
    }
    return [...agents.values()];
}

export async function loadPerformanceSummary(
    path: string,
): Promise<AgentPerformance[]> {
    let source: string;
    try {
        source = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    return summarizePerformance(
        source
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line)),
    );
}
