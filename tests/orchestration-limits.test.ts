import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIGURATION } from '../src/config.ts';
import {
    blockOnLimit,
    ConcurrencyGate,
    OrchestrationLimitError,
    OrchestrationLimits,
} from '../src/orchestration-limits.ts';
import { RunStore } from '../src/run-storage.ts';

const configuration = {
    ...DEFAULT_CONFIGURATION,
    readOnlyConcurrency: 2,
    maxDelegations: 2,
    maxRepairCycles: 1,
};

test('concurrency gates queue fairly and never exceed their configured limit', async () => {
    const gate = new ConcurrencyGate(2);
    let active = 0;
    let maximum = 0;
    const order: number[] = [];
    const work = (id: number) =>
        gate.run(async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            order.push(id);
            await new Promise((resolve) => setTimeout(resolve, 15));
            active -= 1;
        });
    await Promise.all([work(1), work(2), work(3), work(4)]);
    assert.equal(maximum, 2);
    assert.deepEqual(order, [1, 2, 3, 4]);
    assert.equal(gate.active, 0);
});

test('queued concurrency work can be cancelled without occupying a slot', async () => {
    const gate = new ConcurrencyGate(1);
    let release!: () => void;
    const first = gate.run(
        () => new Promise<void>((resolve) => (release = resolve)),
    );
    const controller = new AbortController();
    const queued = gate.run(async () => {}, controller.signal);
    controller.abort();
    await assert.rejects(queued, { name: 'AbortError' });
    assert.equal(gate.queued, 0);
    release();
    await first;
});

test('run limits share delegation, implementer, repair and resumed budgets', async () => {
    const limits = new OrchestrationLimits(configuration, {
        usedDelegations: 1,
    });
    limits.consumeDelegation('explorer');
    assert.throws(
        () => limits.consumeDelegation('planner'),
        (error: unknown) =>
            error instanceof OrchestrationLimitError &&
            error.limitName === 'delegations' &&
            error.outcome === 'blocked',
    );
    limits.consumeRepairCycle();
    assert.throws(
        () => limits.consumeRepairCycle(),
        (error: unknown) =>
            error instanceof OrchestrationLimitError &&
            error.limitName === 'repair_cycles',
    );

    let active = 0;
    let maximum = 0;
    const implement = () =>
        limits.runImplementer(async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
        });
    await Promise.all([implement(), implement()]);
    assert.equal(maximum, 1);
});

test('runtime deadline aborts work and reports the exhausted limit', async () => {
    const limits = new OrchestrationLimits({
        ...configuration,
        runTimeoutMs: 25,
        commandTimeoutMs: 10,
    });
    let aborted = false;
    await assert.rejects(
        limits.runWithinDeadline(
            (signal) =>
                new Promise<void>((resolve) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            aborted = true;
                            resolve();
                        },
                        { once: true },
                    );
                }),
        ),
        (error: unknown) =>
            error instanceof OrchestrationLimitError &&
            error.limitName === 'run_timeout',
    );
    assert.equal(aborted, true);
});

test('policy exhaustion blocks a run while infrastructure failures do not', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'flue-limits-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, 'repository');
    await mkdir(repository);
    const store = new RunStore({ root: join(root, 'state') });
    const blocked = await store.create({ repository, configuration });
    const error = new OrchestrationLimitError('delegations', 2, 2);
    await assert.rejects(
        blockOnLimit(store, blocked.id, async () => {
            throw error;
        }),
        error,
    );
    assert.equal((await store.read(blocked.id)).status, 'blocked');

    const failed = await store.create({ repository, configuration });
    await assert.rejects(
        blockOnLimit(store, failed.id, async () => {
            throw new Error('network unavailable');
        }),
        /network unavailable/,
    );
    assert.equal((await store.read(failed.id)).status, 'running');
});
