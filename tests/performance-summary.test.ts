import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizePerformance } from '../src/performance-summary.ts';

const turn = (agent: string, turnId: string, tokens: number, ms: number) => ({
    event: 'llm_output',
    agent,
    turnId,
    promptId: 'p',
    timings: {
        predicted_n: tokens,
        predicted_ms: ms,
        predicted_per_second: 999,
    },
});

test('rates are total tokens over total generation time, across calls and resumed prompts', () => {
    const events = [
        { type: 'prompt_start' },
        {
            type: 'llm_start',
            agent: 'orchestrator',
            turnId: 'a',
            promptId: 'p',
        },
        turn('orchestrator', 'a', 100, 1000),
        { ...turn('orchestrator', 'b', 100, 9000), promptId: 'resumed' },
        turn('explorer', 'c', 60, 2000),
        turn('explorer', 'd', 40, 3000),
        turn('explorer', 'd', 40, 3000), // duplicate terminal observation
        { type: 'subagent_end', agent: 'explorer', outputTokens: 100 },
    ];
    const rows = summarizePerformance(events);
    assert.equal(rows[0].averageTokensPerSecond, 20); // not (100 + 11.11) / 2
    assert.equal(rows[0].llmCalls, 2);
    assert.equal(rows[1].averageTokensPerSecond, 20);
    assert.equal(rows[1].llmCalls, 2);
    assert.equal(rows[1].generatedTokens, 100);
});

test('missing timings, interrupted turns and zero durations do not produce misleading rates', () => {
    const rows = summarizePerformance([
        { type: 'subagent_start', agent: 'planner' },
        turn('reviewer', 'a', 10, 1000),
        { event: 'llm_output', agent: 'reviewer', turnId: 'b' },
        turn('implementer', 'c', 0, 0),
        { type: 'llm_start', agent: 'explorer', turnId: 'interrupted' },
    ]);
    assert.ok(rows.every((row) => row.averageTokensPerSecond === null));
    assert.equal(rows[0].llmCalls, 0);
    assert.equal(rows[1].llmCalls, 2);
    assert.equal(rows[1].measuredCalls, 1);
    assert.equal(rows[3].llmCalls, 1);
});
