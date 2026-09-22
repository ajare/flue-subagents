import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFlueIntegrationProbe } from '../src/prototypes/flue-integration.ts';

test('Flue supports parallel delegation, cancellation and continuation offline', {
    timeout: 15_000,
}, async () => {
    const report = await runFlueIntegrationProbe();
    assert.equal(report.parallelDelegation.maximumConcurrentChildren, 2);
    assert.deepEqual(report.parallelDelegation.taskResults.toSorted(), [
        'alpha result',
        'beta result',
    ]);
    assert.equal(report.cancellation.outcome, 'aborted');
    assert.equal(
        report.continuation.originalUid,
        report.continuation.continuedUid,
    );
});
