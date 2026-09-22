import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ORCHESTRATOR_POLICY } from '../src/agents/orchestrator.ts';
import { DEFAULT_CONFIGURATION } from '../src/config.ts';
import { replayLedger } from '../src/delegation-ledger.ts';
import { OrchestrationLimits } from '../src/orchestration-limits.ts';
import {
    assertOrchestrationIntegrity,
    assertSelfContainedBriefing,
    formatOrchestratorResult,
    OrchestrationDefectError,
    OrchestrationPolicyController,
    validateOrchestratorResult,
} from '../src/orchestrator-policy.ts';
import { RunStore } from '../src/run-storage.ts';

const briefing = (extra = '') => `Objective: Implement a bounded change.
Acceptance criteria: Focused tests pass.
Constraints: Preserve public APIs.
Context and evidence: src/example.ts contains the target.
Prior decisions and results: None.
Role task: Make and validate the focused change.
${extra}`;

const implementerResult = JSON.stringify({
    schemaVersion: 1,
    role: 'implementer',
    summary: 'Implemented the change.',
    changes: [{ path: 'src/example.ts', summary: 'Updated behavior.' }],
    commands: [],
    unresolvedIssues: [],
});

async function fixture(
    t: TestContext,
    overrides: Partial<typeof DEFAULT_CONFIGURATION> = {},
) {
    const root = await mkdtemp(join(tmpdir(), 'flue-policy-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, 'repository');
    await mkdir(repository);
    const store = new RunStore({ root: join(root, 'state') });
    const configuration = {
        ...DEFAULT_CONFIGURATION,
        implementerConcurrency: 1,
        ...overrides,
    };
    const run = await store.create({ repository, configuration });
    const limits = new OrchestrationLimits(configuration);
    const controller = new OrchestrationPolicyController({
        conversationId: 'conversation',
        store,
        runId: run.id,
        limits,
    });
    return { store, run, controller };
}

test('policy is application-owned and makes delegation proportionate', () => {
    assert.match(ORCHESTRATOR_POLICY, /trivial question directly/);
    assert.match(ORCHESTRATOR_POLICY, /parallel tool batch/);
    assert.match(ORCHESTRATOR_POLICY, /Use a planner for cross-cutting/);
    assert.match(ORCHESTRATOR_POLICY, /Never modify files yourself/);
    assert.match(ORCHESTRATOR_POLICY, /status": "completed/);
    assert.match(ORCHESTRATOR_POLICY, /Use needs_input only/);
});

test('terminal results enforce precise needs-input and completed shapes', () => {
    const needsInput = validateOrchestratorResult(
        JSON.stringify({
            schemaVersion: 1,
            status: 'needs_input',
            summary: 'A compatibility decision is required.',
            questions: [
                'Must v1 clients remain compatible, or may this release require v2?',
            ],
        }),
    );
    assert.match(formatOrchestratorResult(needsInput), /Clarification needed/);
    assert.throws(
        () =>
            validateOrchestratorResult({
                schemaVersion: 1,
                status: 'needs_input',
                summary: 'Ambiguous.',
                questions: [],
            }),
        OrchestrationDefectError,
    );
    assert.throws(
        () =>
            validateOrchestratorResult({
                schemaVersion: 1,
                status: 'completed',
                summary: 'Done.',
                questions: ['Unneeded question?'],
            }),
        OrchestrationDefectError,
    );
});

test('briefings reject omitted context and require review evidence', () => {
    assert.doesNotThrow(() =>
        assertSelfContainedBriefing('implementer', briefing()),
    );
    assert.throws(
        () =>
            assertSelfContainedBriefing(
                'implementer',
                'Objective: Change behavior.\nRole task: Implement it.',
            ),
        (error: unknown) =>
            error instanceof OrchestrationDefectError &&
            error.missingSections.includes('Context and evidence'),
    );
    assert.throws(
        () => assertSelfContainedBriefing('reviewer', briefing()),
        (error: unknown) =>
            error instanceof OrchestrationDefectError &&
            error.missingSections.includes('Diff') &&
            error.missingSections.includes('Validation report'),
    );
    assert.doesNotThrow(() =>
        assertSelfContainedBriefing(
            'reviewer',
            briefing(`Plan: No separate plan was used.
Diff: Obtain revision abc from the current workspace.
Validation report: npm test passed with exit code 0.
Known limitations and unresolved issues: None.`),
        ),
    );
});

test('task boundary serializes implementers and records validated results', async (t) => {
    const { store, run, controller } = await fixture(t);
    for (const id of ['one', 'two']) {
        controller.registerDelegation({
            id,
            role: 'implementer',
            prompt: briefing(),
        });
    }
    let active = 0;
    let maximum = 0;
    const invoke = (id: string) =>
        controller.intercept(
            { type: 'task', taskId: id },
            { instanceId: 'conversation' },
            async () => {
                active += 1;
                maximum = Math.max(maximum, active);
                await new Promise((resolve) => setTimeout(resolve, 10));
                active -= 1;
                return { text: implementerResult };
            },
        );
    await Promise.all([invoke('one'), invoke('two')]);

    assert.equal(maximum, 1);
    const entries = replayLedger((await store.read(run.id)).ledger).delegations;
    assert.deepEqual(
        entries.map((entry) => entry.id),
        ['one', 'two'],
    );
    assert.ok(entries.every((entry) => entry.result?.role === 'implementer'));
});

test('task-tool budget exhaustion blocks the run', async (t) => {
    const { store, run, controller } = await fixture(t, {
        maxDelegations: 1,
    });
    for (const id of ['allowed', 'exhausted']) {
        controller.registerDelegation({
            id,
            role: 'implementer',
            prompt: briefing(),
        });
    }
    const invoke = (id: string) =>
        controller.intercept(
            { type: 'task', taskId: id },
            { instanceId: 'conversation' },
            async () => ({ text: implementerResult }),
        );
    await invoke('allowed');
    await assert.rejects(invoke('exhausted'), {
        code: 'orchestration_limit_exhausted',
        limitName: 'delegations',
    });
    const record = await store.read(run.id);
    assert.equal(record.status, 'blocked');
    assert.match(
        replayLedger(record.ledger).delegations[1]?.failure ?? '',
        /delegations exhausted/,
    );
});

test('missing task context is persisted as an orchestration failure', async (t) => {
    const { store, run, controller } = await fixture(t);
    controller.registerDelegation({
        id: 'incomplete',
        role: 'implementer',
        prompt: 'Objective: Change behavior.\nRole task: Implement it.',
    });
    await assert.rejects(
        controller.intercept(
            { type: 'task', taskId: 'incomplete' },
            { instanceId: 'conversation' },
            async () => ({ text: implementerResult }),
        ),
        OrchestrationDefectError,
    );
    const ledger = (await store.read(run.id)).ledger;
    const entry = replayLedger(ledger).delegations[0];
    assert.match(entry?.failure ?? '', /Incomplete implementer briefing/);
    assert.equal(entry?.result, null);
    const completed = validateOrchestratorResult({
        schemaVersion: 1,
        status: 'completed',
        summary: 'Done.',
        questions: [],
        failureWaivers: [
            { delegationId: 'incomplete', reason: 'No longer needed.' },
        ],
    });
    assert.throws(
        () => assertOrchestrationIntegrity(completed, ledger),
        /Unresolved implementer delegation failure/,
    );
});
