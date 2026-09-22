import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_CONFIGURATION } from '../src/config.ts';
import {
    completionEligibility,
    replayLedger,
    type LedgerAction,
} from '../src/delegation-ledger.ts';
import { delegateWithLedger } from '../src/delegation.ts';
import { createDelegationBudget } from '../src/result-contracts.ts';
import { RunStore } from '../src/run-storage.ts';

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'flue-ledger-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, 'repo');
    await mkdir(repository);
    const store = new RunStore({ root: join(root, 'state') });
    const run = await store.create({
        repository,
        configuration: DEFAULT_CONFIGURATION,
    });
    const append = (ledgerAction: LedgerAction) =>
        store.update(run.id, { ledgerAction });
    return { store, runId: run.id, append };
}
const explorer = {
    schemaVersion: 1,
    role: 'explorer',
    summary: 'done',
    findings: [],
    evidence: [],
    openQuestions: [],
};
const review = {
    schemaVersion: 1,
    role: 'reviewer',
    verdict: 'approved',
    summary: 'done',
    findings: [],
    validation: [],
    limitations: [],
};
const patch = (
    revisionHash: string,
    diffHash = revisionHash,
): LedgerAction => ({ type: 'patch', patch: { revisionHash, diffHash } });
const start = (
    id: string,
    role: 'reviewer' | 'explorer' = 'reviewer',
): Extract<LedgerAction, { type: 'start' }> => ({
    type: 'start',
    id,
    role,
    task: 'inspect',
    parentId: null,
});

test('approval is bound to exact patch epoch and diff, including mutations during review', async (t) => {
    const { append } = await fixture(t);
    await append(patch('a'));
    await append(start('r1'));
    let run = await append({ type: 'result', id: 'r1', result: review });
    assert.equal(completionEligibility(run.ledger).eligible, true);
    run = await append(patch('b', 'a'));
    assert.equal(completionEligibility(run.ledger).eligible, false);
    run = await append(patch('a'));
    assert.equal(completionEligibility(run.ledger).eligible, false);
    await append(start('r2'));
    await append(patch('c'));
    run = await append({ type: 'result', id: 'r2', result: review });
    assert.equal(completionEligibility(run.ledger).eligible, false);
    await append(start('r3'));
    run = await append({ type: 'result', id: 'r3', result: review });
    assert.equal(completionEligibility(run.ledger).approvalId, 'r3');
});

test('parallel delegations preserve start order, identity, parentage and atomic run updates', async (t) => {
    const { store, runId, append } = await fixture(t);
    await append(start('parent', 'explorer'));
    await Promise.all(
        ['a', 'b'].map((id) =>
            append({ ...start(id, 'explorer'), parentId: 'parent' }),
        ),
    );
    await Promise.all([
        append({ type: 'result', id: 'b', result: explorer }),
        store.update(runId, { conversationId: 'continued' }),
        append({ type: 'failure', id: 'a', message: 'failed' }),
    ]);
    const loaded = await new RunStore({ root: store.root }).read(runId);
    const entries = replayLedger(loaded.ledger).delegations;
    assert.deepEqual(
        entries.map((entry) => entry.id),
        ['parent', 'a', 'b'],
    );
    assert.equal(entries[1].failure, 'failed');
    assert.equal(entries[2].result?.role, 'explorer');
    assert.equal(entries[2].parentId, 'parent');
    assert.equal(loaded.conversationId, 'continued');
    assert.equal(loaded.revision, 6);
    assert.ok(Object.isFrozen(loaded.ledger[0].action));
    assert.equal(completionEligibility(loaded.ledger).eligible, false);
});

test('validated delegation persists corrective retries and terminal malformed failure', async (t) => {
    const { store, runId } = await fixture(t);
    const budget = createDelegationBudget(4);
    const options = {
        store,
        runId,
        budget,
        role: 'explorer' as const,
        prompt: 'inspect',
    };
    await delegateWithLedger({
        ...options,
        id: 'good',
        delegate: (_, { attempt }) => (attempt === 1 ? 'bad' : explorer),
    });
    await assert.rejects(
        delegateWithLedger({ ...options, id: 'bad', delegate: () => 'bad' }),
    );
    const entries = replayLedger((await store.read(runId)).ledger).delegations;
    assert.equal(entries[0].retries, 1);
    assert.equal(entries[0].malformedResults.length, 1);
    assert.equal(entries[0].result?.role, 'explorer');
    assert.equal(entries[1].malformedResults.length, 2);
    assert.ok(entries[1].failure);
    assert.equal(budget.used, 4);
});

test('invalid actions leave run record unchanged; corrupted persisted evidence fails closed', async (t) => {
    const { store, runId, append } = await fixture(t);
    await append(start('e', 'explorer'));
    const before = await readFile(store.recordPath(runId), 'utf8');
    await assert.rejects(append({ type: 'result', id: 'e', result: review }));
    await assert.rejects(append(start('e', 'explorer')));
    await assert.rejects(append({ type: 'retry', id: 'missing' }));
    assert.equal(await readFile(store.recordPath(runId), 'utf8'), before);
    const corrupt = JSON.parse(before);
    corrupt.ledger[0].sequence = 2;
    await writeFile(store.recordPath(runId), JSON.stringify(corrupt));
    await assert.rejects(store.read(runId), /Invalid delegation ledger/);
});
