import assert from 'node:assert/strict';
import test from 'node:test';
import { currentEventOwner, withEventOwner } from '../src/event-owner.ts';
import { setTimeout } from 'node:timers/promises';

test('event owners remain isolated across concurrent delegations', async () => {
    assert.deepEqual(currentEventOwner(), { agent: 'orchestrator' });
    await Promise.all(['explorer', 'reviewer'].map((agent, index) => {
        const owner = { agent, taskId: `task-${index}` };
        return withEventOwner(owner, async () => {
            await setTimeout(index === 0 ? 10 : 1);
            assert.deepEqual(currentEventOwner(), owner);
            await setTimeout(10);
            assert.deepEqual(currentEventOwner(), owner);
        });
    }));
    assert.deepEqual(currentEventOwner(), { agent: 'orchestrator' });
});
