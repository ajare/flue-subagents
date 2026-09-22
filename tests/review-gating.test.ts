import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIGURATION } from '../src/config.ts';
import {
    completionEligibility,
    type LedgerAction,
    type LedgerEvent,
} from '../src/delegation-ledger.ts';
import { preflightGitRepository } from '../src/git-preflight.ts';
import { OrchestrationLimits } from '../src/orchestration-limits.ts';
import { OrchestrationPolicyController } from '../src/orchestrator-policy.ts';
import { PatchManager } from '../src/patch-publication.ts';
import type { ReviewerResult } from '../src/result-contracts.ts';
import { ReviewBoundary } from '../src/review-gating.ts';
import { RunStore } from '../src/run-storage.ts';
import { WorkspaceManager } from '../src/workspaces.ts';
import { createGitFixture } from './helpers/git.ts';

const approved: ReviewerResult = {
    schemaVersion: 1,
    role: 'reviewer',
    verdict: 'approved',
    summary: 'Inspected behavior',
    findings: [],
    validation: [],
    limitations: [],
};
function ledger() {
    const events: LedgerEvent[] = [];
    const append = (action: LedgerAction) =>
        events.push({
            sequence: events.length + 1,
            at: new Date(0).toISOString(),
            action,
        });
    const patch = (hash: string) =>
        append({
            type: 'patch',
            patch: { revisionHash: hash, diffHash: hash },
        });
    const review = (id: string, result: ReviewerResult) => {
        append({
            type: 'start',
            id,
            role: 'reviewer',
            task: 'review concern',
            parentId: null,
        });
        append({ type: 'result', id, result });
    };
    patch('initial');
    patch('changed');
    return { events, append, patch, review };
}

test('all current reviewers must approve; repair needs fresh review of its exact revision', () => {
    const { events, review, patch } = ledger();
    review('correctness', {
        ...approved,
        verdict: 'changes_requested',
        findings: [
            {
                severity: 'blocking',
                description: 'Reproducer: incorrect result',
            },
        ],
    });
    review('security', approved);
    assert.equal(completionEligibility(events).eligible, false);
    patch('repaired');
    assert.equal(completionEligibility(events).eligible, false);
    review('fresh', approved);
    assert.equal(completionEligibility(events).eligible, true);
    patch('another');
    patch('repaired');
    assert.equal(completionEligibility(events).eligible, false);
});

test('optional validation requires explicit limitations, central missing validation blocks', () => {
    for (const scope of ['optional', 'central'] as const) {
        const { events, review } = ledger();
        review('validation', {
            ...approved,
            verdict: 'approved_with_limitations',
            validation: [
                {
                    command: 'integration test',
                    result: 'not_run',
                    exitCode: null,
                    summary: 'Service unavailable',
                    scope,
                },
            ],
            limitations: ['Service unavailable'],
        });
        const gate = completionEligibility(events);
        assert.equal(gate.eligible, scope === 'optional');
        assert.deepEqual(gate.warnings, ['Service unavailable']);
    }
    const { events, review } = ledger();
    review('empty-limitations', {
        ...approved,
        verdict: 'approved_with_limitations',
    });
    assert.equal(completionEligibility(events).eligible, false);
});

test('review boundary permits parallel reviewers but isolates queued repairs', async () => {
    const boundary = new ReviewBoundary();
    const order: string[] = [];
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    const first = boundary.run(false, async () => {
        order.push('review1');
        await wait;
    });
    const second = boundary.run(false, async () => {
        order.push('review2');
        await wait;
    });
    const repair = boundary.run(true, async () => {
        order.push('repair');
    });
    const fresh = boundary.run(false, async () => {
        order.push('fresh');
    });
    await Promise.resolve();
    assert.deepEqual(order, ['review1', 'review2']);
    release();
    await Promise.all([first, second, repair, fresh]);
    assert.deepEqual(order, ['review1', 'review2', 'repair', 'fresh']);
});

test('real workspace reviewer mutation is quarantined and completion fails closed', async (t) => {
    const repo = await createGitFixture(t);
    const store = new RunStore({
        root: join(dirname(repo.path), 'review-state'),
    });
    const run = await store.create({
        repository: repo.path,
        configuration: DEFAULT_CONFIGURATION,
    });
    const baseline = await preflightGitRepository(repo.path, { env: repo.env });
    const workspaces = new WorkspaceManager(store, repo.env);
    const workspace = await workspaces.create(run.id, baseline);
    const patches = new PatchManager(store, repo.env);
    await patches.initialize(run.id, baseline);
    await writeFile(join(workspace, 'README.md'), 'implementation');
    await patches.capture(run.id);
    await assert.rejects(
        store.update(run.id, { status: 'completed' }),
        /Review gate/,
    );
    const controller = new OrchestrationPolicyController({
        conversationId: 'root',
        runId: run.id,
        store,
        patches,
        limits: new OrchestrationLimits(DEFAULT_CONFIGURATION),
    });
    controller.registerDelegation({
        id: 'review',
        role: 'reviewer',
        prompt: [
            'Objective',
            'Acceptance criteria',
            'Constraints',
            'Context and evidence',
            'Prior decisions and results',
            'Role task',
            'Plan',
            'Diff',
            'Validation report',
            'Known limitations and unresolved issues',
        ]
            .map((heading) => `${heading}: supplied`)
            .join('\n'),
    });
    await assert.rejects(
        controller.intercept(
            { type: 'task', taskId: 'review' },
            { instanceId: 'root' },
            async () => {
                await writeFile(
                    join(workspace, 'README.md'),
                    'reviewer mutation',
                );
                return approved;
            },
        ),
        /Reviewer changed source/,
    );
    assert.equal((await store.read(run.id)).status, 'blocked');
    assert.equal(
        completionEligibility((await store.read(run.id)).ledger).eligible,
        false,
    );
});

test('two unsuccessful repairs block a third attempt and retain unresolved findings', async (t) => {
    const repo = await createGitFixture(t);
    const store = new RunStore({
        root: join(dirname(repo.path), 'repair-state'),
    });
    const run = await store.create({
        repository: repo.path,
        configuration: DEFAULT_CONFIGURATION,
    });
    const initial = ledger();
    initial.review('review', {
        ...approved,
        verdict: 'changes_requested',
        findings: [{ severity: 'blocking', description: 'Still incorrect' }],
    });
    for (const event of initial.events)
        await store.update(run.id, { ledgerAction: event.action });
    const limits = new OrchestrationLimits(DEFAULT_CONFIGURATION);
    const controller = new OrchestrationPolicyController({
        conversationId: 'root',
        runId: run.id,
        store,
        limits,
    });
    const repair = (id: string) => {
        controller.registerDelegation({
            id,
            role: 'implementer',
            prompt: [
                'Objective',
                'Acceptance criteria',
                'Constraints',
                'Context and evidence',
                'Prior decisions and results',
                'Role task',
            ]
                .map((heading) => `${heading}: repair finding`)
                .join('\n'),
        });
        return controller.intercept(
            { type: 'task', taskId: id },
            { instanceId: 'root' },
            async () => ({
                schemaVersion: 1,
                role: 'implementer',
                summary: 'Attempted repair',
                changes: [],
                commands: [],
                unresolvedIssues: ['Still incorrect'],
            }),
        );
    };
    await repair('repair1');
    await repair('repair2');
    await assert.rejects(repair('repair3'), /Two repair cycles exhausted/);
    assert.equal(limits.repairCyclesUsed, 2);
    const record = await store.read(run.id);
    assert.equal(record.status, 'blocked');
    assert.ok(
        completionEligibility(record.ledger).reasons.includes(
            'Still incorrect',
        ),
    );
});
