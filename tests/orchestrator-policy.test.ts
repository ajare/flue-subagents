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
import { AgentNames } from '../src/agent-names.ts';
import { PatchManager } from '../src/patch-publication.ts';
import type { SubagentRole } from '../src/result-contracts.ts';

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
    return { store, run, controller, limits };
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

test('terminal results accept a single outer JSON fence without weakening validation', () => {
    const decision = {
        schemaVersion: 1,
        status: 'completed',
        summary: 'Approximately 187,700 physical lines, excluding submodules.',
        questions: [],
        failureWaivers: [],
    };
    const json = JSON.stringify(decision, null, 2);
    for (const label of ['json', '']) {
        const fenced = `\`\`\`${label}\n${json}\n\`\`\``;
        assert.deepEqual(validateOrchestratorResult(fenced), decision);
        assert.deepEqual(
            validateOrchestratorResult(
                ` \r\n${fenced.replaceAll('\n', '\r\n')}\r\n `,
            ),
            decision,
        );
    }
    for (const invalid of [
        `Here is the result:\n\`\`\`json\n${json}\n\`\`\``,
        `\`\`\`json\n${json}\n\`\`\`\nExtra commentary`,
        `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
        `\`\`\`json\n${json}\n${json}\n\`\`\``,
        `\`\`\`json\n${json}`,
        '```json\n{invalid}\n```',
        '```json\n{}\n```',
        '```json\n[]\n```',
        `\`\`\`json\n${JSON.stringify({ ...decision, questions: ['Why?'] })}\n\`\`\``,
    ]) {
        assert.throws(
            () => validateOrchestratorResult(invalid),
            OrchestrationDefectError,
        );
    }
});

test('briefings default optional context to none and require core review evidence', () => {
    assert.doesNotThrow(() =>
        assertSelfContainedBriefing('implementer', briefing()),
    );
    assert.doesNotThrow(() =>
        assertSelfContainedBriefing(
            'implementer',
            'Objective: Change behavior.\nRole task: Implement it.',
        ),
    );
    assert.throws(
        () =>
            assertSelfContainedBriefing(
                'implementer',
                'Objective: Change behavior.',
            ),
        (error: unknown) =>
            error instanceof OrchestrationDefectError &&
            error.missingSections.includes('Role task'),
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
            `Objective: Review the change.
Role task: Review revision abc.
Plan: No separate plan was used.
Diff: Obtain revision abc from the current workspace.
Validation report: npm test passed with exit code 0.
Known limitations and unresolved issues: None.`,
        ),
    );
});

test('implementer task boundary accepts the historical Changes to make briefing', async (t) => {
    const { store, run, controller } = await fixture(t);
    const task =
        '### 1. Simulation RNG\nAdd a deterministic simulation RNG.\n\n### 2. Diagnostics\nExpose the active decision.';
    controller.registerDelegation({
        id: 'markdown-task',
        role: 'implementer',
        prompt: `Objective: Implement escalator walking.\n\n## Already implemented (do not modify)\nTag properties are done.\n\n## Changes to make\n${task}\n\n## Constraints\nDo not change pathfinding.\n\n## Verification\nRun the headless suite.`,
    });
    let calls = 0;
    await controller.intercept(
        { type: 'task', taskId: 'markdown-task' },
        { instanceId: 'conversation' },
        async () => {
            calls++;
            return { text: implementerResult };
        },
    );
    assert.equal(calls, 1);
    const ledger = (await store.read(run.id)).ledger;
    const entry = replayLedger(ledger).delegations[0];
    assert.equal(entry?.task, task);
    assert.equal(entry?.result?.role, 'implementer');
    assert.equal(entry?.failure, null);
});

test('Changes to make cannot replace missing content or reviewer task requirements', () => {
    for (const prompt of [
        'Objective: Implement it.\n## Changes to make\n\n## Constraints\nPreserve APIs.',
        'Objective: Implement it.\n## Changes to make\nConstraints: Preserve APIs.',
        'Objective: Implement it.\n## Changes to make\n## Verification\nRun tests.',
        'Objective: Implement it.\n~~~markdown\nRole task: Example only.\n~~~',
        'Objective: Implement it.\n```markdown\n## Changes to make\nExample only.\n```',
        '## Changes to make\nImplement it.',
    ]) {
        assert.throws(
            () => assertSelfContainedBriefing('implementer', prompt),
            OrchestrationDefectError,
        );
    }
    assert.throws(
        () =>
            assertSelfContainedBriefing(
                'reviewer',
                'Objective: Review.\n## Changes to make\nReview it.',
            ),
        (error: unknown) =>
            error instanceof OrchestrationDefectError &&
            error.missingSections.includes('Role task'),
    );
});

test('Markdown briefing headings accept CRLF and preserve fenced task examples', async (t) => {
    const { store, run, controller } = await fixture(t);
    const task =
        'Implement the example:\n```text\n## Constraints\nDo not interpret this as a briefing heading.\n```\nThen test it.';
    const prompt =
        `# Objective\nImplement behavior.\n## Role task:\n${task}\n## Verification\nRun tests.`.replaceAll(
            '\n',
            '\r\n',
        );
    controller.registerDelegation({
        id: 'fenced-example',
        role: 'implementer',
        prompt,
    });
    await controller.intercept(
        { type: 'task', taskId: 'fenced-example' },
        { instanceId: 'conversation' },
        async () => ({ text: implementerResult }),
    );
    assert.equal(
        replayLedger((await store.read(run.id)).ledger).delegations[0]?.task,
        task,
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
    const ledger = (await store.read(run.id)).ledger;
    assert.deepEqual(ledger.filter((entry) => entry.action.type === 'start').map((entry) => entry.agent), ['implementer-1', 'implementer-2']);
    for (const entry of ledger) {
        assert.equal(entry.agent, entry.taskId === 'one' ? 'implementer-1' : 'implementer-2');
    }
});

test('explorer task boundary normalizes model formatting without losing findings', async (t) => {
    const { store, run, controller } = await fixture(t);
    const result = {
        schemaVersion: 1,
        role: 'explorer',
        summary: 'Located the property workflow.',
        findings: ['The registry owns properties.'],
        evidence: [
            { path: 'src/registry.ts', observation: 'Defines properties.' },
        ],
        openQuestions: [],
    };
    const checklist = '## Touch-point checklist\n1. Update the registry.';
    // The historical response opened a JSON fence but never closed it, and
    // appended Markdown after a complete, syntactically valid JSON object.
    const raw = `\`\`\`json\n${JSON.stringify({
        ...result,
        evidence: [{ ...result.evidence[0], line: null, symbol: null }],
    })}\n\n${checklist}`;
    controller.registerDelegation({
        id: 'explore',
        role: 'explorer',
        prompt: briefing(),
    });
    const output = await controller.intercept(
        { type: 'task', taskId: 'explore' },
        { instanceId: 'conversation' },
        async () => ({ text: raw, metadata: { retained: true } }),
    );
    const expected = { ...result, findings: [...result.findings, checklist] };
    assert.deepEqual(JSON.parse(output.text), expected);
    assert.deepEqual(output.metadata, { retained: true });
    assert.deepEqual(
        replayLedger((await store.read(run.id)).ledger).delegations[0]?.result,
        expected,
    );
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

test('missing required task context is rejected without a delegation failure', async (t) => {
    const { store, run, controller } = await fixture(t);
    controller.registerDelegation({
        id: 'incomplete',
        role: 'implementer',
        prompt: 'Objective: Change behavior.',
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
    assert.deepEqual(replayLedger(ledger).delegations, []);
    const completed = validateOrchestratorResult({
        schemaVersion: 1,
        status: 'completed',
        summary: 'Done.',
        questions: [],
        failureWaivers: [],
    });
    assert.doesNotThrow(() => assertOrchestrationIntegrity(completed, ledger));
});


test('preflight precedes names, patch capture, gates and both budgets; corrected reviewer is reviewer-1', async (t) => {
    const { store, run, limits } = await fixture(t, { maxDelegations: 1 });
    const names = new AgentNames(join(store.runDirectory(run.id), 'names.json'));
    const patches = new PatchManager(store);
    const capture = t.mock.method(patches, 'capture', async () => undefined);
    const latest = t.mock.method(patches, 'latest', async () => undefined);
    const readOnly = t.mock.method(limits, 'runReadOnly');
    const writer = t.mock.method(limits, 'runImplementer');
    const controller = new OrchestrationPolicyController({
        conversationId: 'conversation', store, runId: run.id, limits, agentNames: names, patches,
    });
    const review = 'Role task: Review.\nPlan: None.\nDiff: Inspect workspace.\nValidation report: Tests passed.\nKnown limitations and unresolved issues: None.';
    const invalid = [
        { role: 'reviewer', prompt: review, missing: ['Objective'] },
        { role: 'reviewer', prompt: briefing(), missing: ['Plan', 'Diff', 'Validation report', 'Known limitations and unresolved issues'] },
        { role: 'implementer', prompt: 'Objective: Change.', missing: ['Role task'] },
        { role: 'explorer', prompt: 'Role task: Explore.', missing: ['Objective'] },
        { role: 'unauthorized PRIVATE', prompt: briefing(), missing: [] },
    ];
    for (const [index, input] of invalid.entries()) {
        const id = `invalid-${index}`;
        controller.registerDelegation({ id, role: input.role as SubagentRole, prompt: input.prompt });
        await assert.rejects(controller.intercept(
            { type: 'task', taskId: id }, { instanceId: 'conversation' },
            async () => { assert.fail('invalid input reached specialist'); },
        ), (error: unknown) => {
            assert.ok(error instanceof OrchestrationDefectError);
            assert.deepEqual(error.missingSections, input.missing);
            assert.equal(error.reasonCode, input.missing.length ? 'incomplete_briefing' : 'unauthorized_role');
            return true;
        });
    }
    assert.equal(readOnly.mock.callCount(), 0);
    assert.equal(writer.mock.callCount(), 0);
    assert.equal(capture.mock.callCount(), 0);
    assert.equal(latest.mock.callCount(), 0);
    assert.equal(limits.delegationBudget.used, 0);
    assert.equal(limits.repairCyclesUsed, 0);
    assert.deepEqual((await store.read(run.id)).ledger, []);
    await store.update(run.id, { ledgerAction: { type: 'patch', patch: { revisionHash: 'revision', diffHash: 'diff' } } });
    controller.registerDelegation({ id: 'valid', role: 'reviewer', prompt: `Objective: Review.\n${review}` });
    await controller.intercept({ type: 'task', taskId: 'valid' }, { instanceId: 'conversation' }, async () => ({ text: JSON.stringify({
        schemaVersion: 1, role: 'reviewer', verdict: 'approved', summary: 'Approved.', findings: [], validation: [], limitations: [],
    }) }));
    const ledger = (await store.read(run.id)).ledger;
    assert.equal(ledger.find((event) => event.action.type === 'start')?.agent, 'reviewer-1');
    assert.equal(limits.delegationBudget.used, 1);
    assert.equal(new AgentNames(join(store.runDirectory(run.id), 'names.json')).get('valid', 'reviewer'), 'reviewer-1');
    // Even after review (and with the delegation budget exhausted), invalid
    // repair input must not consume a repair cycle or acquire a writer slot.
    const captures = capture.mock.callCount();
    controller.registerDelegation({ id: 'invalid-repair', role: 'implementer', prompt: 'Role task: Repair.' });
    await assert.rejects(controller.intercept(
        { type: 'task', taskId: 'invalid-repair' }, { instanceId: 'conversation' },
        async () => { assert.fail('invalid repair executed'); },
    ), { reasonCode: 'incomplete_briefing' });
    assert.equal(limits.repairCyclesUsed, 0);
    assert.equal(limits.delegationBudget.used, 1);
    assert.equal(writer.mock.callCount(), 0);
    assert.equal(capture.mock.callCount(), captures);
    assert.deepEqual((await store.read(run.id)).ledger, ledger);
    assert.equal((await store.read(run.id)).status, 'running');
    assert.doesNotThrow(() => assertOrchestrationIntegrity(validateOrchestratorResult({
        schemaVersion: 1, status: 'completed', summary: 'Done.', questions: [],
    }), ledger));
});
