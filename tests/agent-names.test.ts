import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentNames } from '../src/agent-names.ts';

test('agent names are per-role, stable by task, and survive restart', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-names-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'agent-names.json');
    const names = new AgentNames(path);
    assert.equal(names.get('a', 'explorer'), 'explorer-1');
    assert.equal(names.get('b', 'explorer'), 'explorer-2');
    assert.equal(names.get('c', 'reviewer'), 'reviewer-1');
    assert.equal(names.get('a', 'explorer'), 'explorer-1');
    const resumed = new AgentNames(path);
    assert.equal(resumed.get('b', 'explorer'), 'explorer-2');
    assert.equal(resumed.get('d', 'explorer'), 'explorer-3');
    assert.equal(resumed.get('e', 'reviewer'), 'reviewer-2');
    assert.equal(new AgentNames().get('a', 'explorer'), 'explorer-1');
});
