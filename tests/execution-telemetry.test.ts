import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FlueObservation } from '@flue/runtime';
import { AgentNames } from '../src/agent-names.ts';
import { ExecutionTelemetry } from '../src/execution-telemetry.ts';
import { AgentMetrics } from '../src/metrics.ts';

test('records parallel tasks, model intervals, missing usage and prompt boundaries without content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telemetry-'));
    try {
        const path = join(dir, 'events.jsonl');
        const published: object[] = [];
        const telemetry = new ExecutionTelemetry(
            path,
            'run',
            'conversation',
            16,
            100,
            (event) => published.push(event),
            undefined,
            64,
        );
        const emit = (event: object) =>
            telemetry.observe({
                v: 3,
                eventIndex: 0,
                timestamp: '2026-01-01T00:00:00.000Z',
                instanceId: 'conversation',
                ...event,
            } as FlueObservation);
        emit({
            type: 'task_start',
            taskId: 'a',
            agent: 'explorer',
            prompt: 'Objective: secret\nRole task: secret',
        });
        emit({
            type: 'task_start',
            taskId: 'b',
            agent: 'planner',
            prompt: 'Objective: secret\nRole task: secret',
        });
        emit({
            type: 'turn',
            taskId: 'a',
            response: { usage: { output: 10, input: 20, cacheRead: 30, cacheWrite: 10 } },
        });
        emit({
            type: 'turn',
            taskId: 'b',
            response: { usage: { output: 20, input: 110, cacheRead: 0, cacheWrite: 0 } },
        });
        emit({ type: 'turn', taskId: 'a', response: { usage: { output: 5 } } });
        emit({ type: 'turn', taskId: 'b', response: {} });
        emit({ type: 'task', taskId: 'a', isError: false });
        emit({ type: 'task', taskId: 'b', isError: true });
        emit({
            type: 'turn_request',
            turnId: 'llm',
            request: { requestedModel: 'model', input: 'secret' },
            purpose: 'agent',
        });
        emit({
            type: 'turn',
            turnId: 'llm',
            response: { usage: { output: 7, input: 0, cacheRead: 0, cacheWrite: 0 } },
            isError: false,
        });
        emit({ type: 'task_start', taskId: 'ignored', instanceId: 'other' });
        emit({ type: 'task_start', taskId: 'interrupted', agent: 'explorer', prompt: 'Objective: secret\nRole task: secret' });
        telemetry.finish('interrupted');
        const second = new ExecutionTelemetry(path, 'run', 'conversation', 16, 100);
        second.finish('completed');
        const raw = await readFile(path, 'utf8');
        const records = raw
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const tasks = records.filter((e) => e.type === 'subagent_end');
        assert.equal(tasks.length, 3);
        assert.equal(tasks[0].outputTokens, 15);
        assert.equal(tasks[0].usageComplete, true);
        assert.equal(tasks[1].outputTokens, 20);
        assert.equal(tasks[1].usageComplete, false);
        assert.equal(tasks[1].status, 'failed');
        assert.equal(tasks[2].status, 'interrupted');
        assert.ok(tasks.every((e) => e.startedAt && e.endedAt));
        assert.equal(
            records.find((e) => e.type === 'orchestrator_llm_end').outputTokens,
            7,
        );
        const outputs = records.filter((e) => e.event === 'llm_output');
        assert.deepEqual(outputs.map((e) => e.outputTokens), [10, 20, 5, null, 7]);
        assert.deepEqual(outputs.map((e) => e.contextTokens), [60, 110, null, null, 0]);
        assert.deepEqual(outputs.map((e) => e.contextUtilization), [0.6, 1, null, null, 0]);
        assert.ok(outputs.every((e) => e.contextWindow === 100));
        assert.ok(outputs.every((e) => e.providerMaxOutputTokens === 64));
        assert.deepEqual(outputs.map((e) => e.outputTokenPercentage), [10 / 16, 1, 5 / 16, null, 7 / 16]);
        assert.deepEqual(outputs.map((e) => e.agent), ['explorer-1', 'planner-1', 'explorer-1', 'planner-1', 'orchestrator']);
        assert.deepEqual(outputs.map((e) => e.taskId), ['a', 'b', 'a', 'b', undefined]);
        assert.ok(outputs.every((e) => Number.isInteger(e.ts)));
        assert.equal(published.length, outputs.length + 1);
        assert.deepEqual(JSON.parse(JSON.stringify(published)), records.filter((event) => event.type === 'event').map(({ schemaVersion, ...event }) => event));
        assert.equal(records.find((event) => event.event === 'delegation_failed').reasonCode, 'specialist_execution_failed');
        assert.notEqual(telemetry.promptId, second.promptId);
        assert.ok(!raw.includes('secret'));
        assert.ok(!raw.includes('ignored'));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('queued read-only tasks are not reported as concurrently active', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'telemetry-queued-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const metrics = new AgentMetrics('run');
    const telemetry = new ExecutionTelemetry(
        join(dir, 'events.jsonl'),
        'run',
        'conversation',
        16,
        100,
        undefined,
        undefined,
        undefined,
        metrics,
    );
    const emit = (event: object) => telemetry.observe({
        timestamp: '2026-01-01T00:00:00.000Z',
        instanceId: 'conversation',
        ...event,
    } as FlueObservation);

    emit({ type: 'task_start', taskId: 'a', agent: 'explorer', prompt: 'Objective: A.\nRole task: A.' });
    emit({ type: 'task_start', taskId: 'b', agent: 'explorer', prompt: 'Objective: B.\nRole task: B.' });
    emit({ type: 'turn_request', taskId: 'a', turnId: 'turn-a', request: { requestedModel: 'model' } });

    const rendered = metrics.render();
    assert.match(rendered, /flue_agent_active\{[^\n]*agent_name="explorer-1"[^\n]*\} 1/u);
    assert.doesNotMatch(rendered, /flue_agent_active\{[^\n]*agent_name="explorer-2"[^\n]*\} 1/u);
    assert.match(rendered, /flue_agent_index\{[^\n]*agent_name="explorer-1"[^\n]*status="active"[^\n]*\} 2/u);
    assert.match(rendered, /flue_agent_index\{[^\n]*agent_name="explorer-2"[^\n]*status="queued"[^\n]*\} 3/u);
});

test('telemetry shares names across prompt continuations and same-role tasks', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'telemetry-names-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'events.jsonl');
    const names = new AgentNames();
    // The policy controller may observe a task before telemetry does.
    assert.equal(names.get('a', 'explorer'), 'explorer-1');
    for (const ids of [['a', 'b'], ['c']]) {
        const telemetry = new ExecutionTelemetry(path, 'run', 'conversation', 16, 100, undefined, names);
        for (const taskId of ids) {
            telemetry.observe({
                type: 'task_start', instanceId: 'conversation', taskId,
                agent: 'explorer', prompt: 'Objective: Explore.\nRole task: Inspect.', timestamp: '2026-01-01T00:00:00.000Z',
            } as FlueObservation);
        }
        telemetry.finish('interrupted');
    }
    const records = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    for (const type of ['subagent_start', 'subagent_end']) {
        assert.deepEqual(records.filter((event) => event.type === type).map((event) => event.agent), ['explorer-1', 'explorer-2', 'explorer-3']);
    }
});
