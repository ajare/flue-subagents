import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FlueObservation } from '@flue/runtime';
import { ExecutionTelemetry } from '../src/execution-telemetry.ts';
import { AgentMetrics, metricsPort, startMetricsServer } from '../src/metrics.ts';
import { statsFetch, withProviderStats } from '../src/provider-stats.ts';

test('endpoint exports live agent lifecycle and closes cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metrics-'));
    const metrics = new AgentMetrics('run');
    const server = await startMetricsServer(metrics, 0);
    try {
        const telemetry = new ExecutionTelemetry(join(dir, 'events'), 'run', 'conversation', 100, 1000, undefined, undefined, undefined, metrics);
        const emit = (event: object) => telemetry.observe({
            v: 3, eventIndex: 0, timestamp: new Date().toISOString(),
            instanceId: 'conversation', ...event,
        } as FlueObservation);
        emit({ type: 'task_start', taskId: 'a', agent: 'explorer', prompt: 'Objective: inspect\nRole task: inspect' });
        emit({ type: 'task_start', taskId: 'b', agent: 'planner', prompt: 'Objective: plan\nRole task: plan' });
        emit({ type: 'turn_request', taskId: 'a', turnId: 'turn-a', request: { requestedModel: 'model' } });
        emit({ type: 'turn_request', taskId: 'b', turnId: 'turn-b', request: { requestedModel: 'model' } });
        emit({ type: 'task_start', taskId: 'ignored', instanceId: 'other', agent: 'reviewer' });
        const url = `http://127.0.0.1:${server.port}/metrics`;
        const response = await fetch(url);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /version=0.0.4/);
        const text = await response.text();
        assert.match(text, /flue_agent_active\{run_id="run",agent_name="explorer-1",agent_type="explorer"\} 1/);
        assert.match(text, /flue_agent_index\{run_id="run",agent_name="orchestrator",agent_type="orchestrator",status="active"\} 1/);
        assert.match(text, /flue_agent_index\{run_id="run",agent_name="explorer-1",agent_type="explorer",status="active"\} 2/);
        assert.match(text, /flue_agent_index\{run_id="run",agent_name="planner-1",agent_type="planner",status="active"\} 3/);
        assert.doesNotMatch(text, /reviewer/);
        emit({ type: 'tool_start', taskId: 'a', toolCallId: 'tool-1', toolName: 'read' });
        emit({ type: 'tool_start', taskId: 'a', toolCallId: 'tool-2', toolName: 'grep' });
        const toolsActive = await (await fetch(url)).text();
        assert.match(toolsActive, /flue_agent_tool_calls_active\{[^\n]*agent_name="explorer-1"[^\n]*\} 2/);
        emit({ type: 'tool', taskId: 'a', toolCallId: 'tool-1', toolName: 'read', isError: false });
        const oneToolActive = await (await fetch(url)).text();
        assert.match(oneToolActive, /flue_agent_tool_calls_active\{[^\n]*agent_name="explorer-1"[^\n]*\} 1/);
        await withProviderStats('turn-a', 'conversation', async () => {
            const response = await statsFetch(async () => new Response(
                'data: {"timings":{"max_tokens_clamped_from":32768,"max_tokens_clamped_to":8192}}\n\n',
                { headers: { 'content-type': 'text/event-stream' } },
            ))('http://unused');
            await response.text();
        });
        emit({
            type: 'turn',
            turnId: 'turn-a',
            taskId: 'a',
            response: { usage: { output: 12, input: 40, cacheRead: 5, cacheWrite: 3 } },
        });
        emit({ type: 'task', taskId: 'a', isError: true });
        const afterExplorer = await (await fetch(url)).text();
        assert.doesNotMatch(afterExplorer, /flue_agent_index\{[^\n]*agent_name="explorer-1"/);
        assert.match(afterExplorer, /flue_agent_index\{[^\n]*agent_name="orchestrator"[^\n]*status="active"[^\n]*\} 1/);
        assert.match(afterExplorer, /flue_agent_index\{[^\n]*agent_name="planner-1"[^\n]*status="active"[^\n]*\} 3/);
        telemetry.finish('interrupted');
        const terminal = await (await fetch(url)).text();
        assert.match(terminal, /flue_agent_status\{[^\n]*agent_name="explorer-1"[^\n]*status="failed"\} 1/);
        assert.match(terminal, /flue_agent_status\{[^\n]*agent_name="planner-1"[^\n]*status="interrupted"\} 1/);
        assert.match(terminal, /flue_agent_output_tokens_total\{[^\n]*agent_name="explorer-1"[^\n]*\} 12/);
        assert.match(terminal, /flue_agent_last_turn_output_tokens\{[^\n]*agent_name="explorer-1"[^\n]*\} 12/);
        assert.doesNotMatch(terminal, /flue_agent_last_turn_output_tokens\{[^\n]*agent_name="planner-1"/);
        assert.match(terminal, /flue_agent_turns_total\{[^\n]*agent_name="explorer-1"[^\n]*\} 1/);
        assert.match(terminal, /flue_agent_turns_total\{[^\n]*agent_name="planner-1"[^\n]*\} 0/);
        assert.match(terminal, /flue_agent_max_tokens_clamped_from\{[^\n]*agent_name="explorer-1"[^\n]*\} 32768/);
        assert.match(terminal, /flue_agent_max_tokens_clamped_to\{[^\n]*agent_name="explorer-1"[^\n]*\} 8192/);
        assert.doesNotMatch(terminal, /flue_agent_max_tokens_clamped_(?:from|to)\{[^\n]*agent_name="planner-1"/);
        assert.match(terminal, /flue_agent_context_tokens\{[^\n]*agent_name="explorer-1"[^\n]*\} 48/);
        assert.doesNotMatch(terminal, /flue_agent_context_tokens\{[^\n]*agent_name="planner-1"/);
        assert.doesNotMatch(terminal, /flue_agent_tool_calls_active\{[^\n]*\} [1-9]/);
        assert.doesNotMatch(terminal, /flue_agent_active\{[^\n]*\} 1/);
        assert.doesNotMatch(terminal, /flue_agent_index\{/);
        assert.equal((await fetch(url, { method: 'POST' })).status, 405);
        assert.equal((await fetch(`${url}/missing`)).status, 404);
    } finally {
        await server.close();
        await rm(dir, { recursive: true, force: true });
    }
    const replacement = await startMetricsServer(metrics, server.port);
    await replacement.close();
});

test('labels are escaped and invalid token usage cannot corrupt token metrics', () => {
    const metrics = new AgentMetrics('run');
    metrics.start('a"\\\nb', 'explorer');
    metrics.addOutputTokens('a"\\\nb', 5);
    assert.match(metrics.render(), /flue_agent_last_turn_output_tokens\{[^\n]*\} 5/);
    metrics.addOutputTokens('a"\\\nb', 3);
    assert.match(metrics.render(), /flue_agent_last_turn_output_tokens\{[^\n]*\} 3/);
    metrics.addOutputTokens('a"\\\nb', Number.NaN);
    metrics.addOutputTokens('a"\\\nb', -1);
    metrics.setContextTokens('a"\\\nb', 42);
    metrics.setContextTokens('a"\\\nb', Number.NaN);
    metrics.setContextTokens('a"\\\nb', -1);
    assert.ok(metrics.render().includes('agent_name="a\\"\\\\\\nb"'));
    assert.match(metrics.render(), /flue_agent_output_tokens_total\{[^\n]*\} 8/);
    assert.doesNotMatch(metrics.render(), /flue_agent_last_turn_output_tokens\{/);
    assert.match(metrics.render(), /flue_agent_context_tokens\{[^\n]*\} 42/);
});

test('metrics are opt-in and validate the port; bind failures reject', async () => {
    assert.equal(metricsPort({}), undefined);
    assert.equal(metricsPort({ FLUE_METRICS_PORT: '9464' }), 9464);
    for (const value of ['', '-1', '65536', '1.5', 'abc'])
        assert.throws(() => metricsPort({ FLUE_METRICS_PORT: value }));
    const metrics = new AgentMetrics('run');
    const server = await startMetricsServer(metrics, 0);
    try {
        await assert.rejects(startMetricsServer(metrics, server.port), { code: 'EADDRINUSE' });
    } finally {
        await server.close();
    }
});
