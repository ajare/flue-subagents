import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defineSubagent, init, useModel, useSubagent } from '@flue/runtime';
import { runCli, startCli } from './helpers/cli.ts';
import { createGitFixture } from './helpers/git.ts';
import {
    createTestRuntime,
    delegationResponses,
    TEST_MODEL,
} from './helpers/runtime.ts';

const cliPath = fileURLToPath(new URL('./fixtures/cli.ts', import.meta.url));

test('Git fixtures are isolated, committed, and disposable', async (t) => {
    const first = await createGitFixture(t);
    const second = await createGitFixture(t);
    assert.notEqual(first.path, second.path);
    assert.equal(await first.git('status', '--porcelain'), '');
    assert.equal(await first.git('branch', '--show-current'), 'main');
    await first.write('src/example.ts', 'export const value = 1;\n');
    assert.match(await first.git('status', '--porcelain'), /src\//);
    assert.equal(await second.git('status', '--porcelain'), '');
    await first.dispose();
    await assert.rejects(access(first.path), { code: 'ENOENT' });
});

test('CLI captures literal arguments, stdin, streams, cwd and exit status', async (t) => {
    const repo = await createGitFixture(t);
    const result = await runCli(
        t,
        cliPath,
        ['two words', '$(not-a-command)', '--fail'],
        {
            stdin: 'line one\nline two\n',
            cwd: repo.path,
            env: repo.env,
        },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
        args: ['two words', '$(not-a-command)', '--fail'],
        stdin: 'line one\nline two\n',
        cwd: repo.path,
    });
    assert.equal(result.stderr, 'fixture stderr\n');
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal((await runCli(t, cliPath)).code, 0);
});

test('CLI supports readiness-driven signals', {
    timeout: 15_000,
}, async (t) => {
    const cli = startCli(t, cliPath, ['--wait']);
    await new Promise<void>((resolve, reject) => {
        cli.child.stdout.once('data', () => resolve());
        void cli.result.then(
            () => reject(new Error('Exited before ready')),
            reject,
        );
    });
    assert.equal(cli.signal('SIGTERM'), true);
    const result = await cli.result;
    assert.equal(result.stdout, 'ready\n');
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(result.code, null);
});

test('CLI timeout kills a stuck subprocess', async (t) => {
    await assert.rejects(
        runCli(t, cliPath, ['--wait'], { timeoutMs: 100 }),
        /CLI timed out/,
    );
});

function Worker() {
    return 'Return the requested fixture result.';
}
const worker = defineSubagent({
    name: 'fixture-worker',
    description: 'Test worker',
    agent: Worker,
});
function Orchestrator() {
    useModel(TEST_MODEL);
    useSubagent(worker);
    return 'Delegate to the fixture worker.';
}

test('scripted model drives deterministic subagent results without a server', {
    timeout: 15_000,
}, async (t) => {
    const expected = JSON.stringify({
        status: 'complete',
        files: ['README.md'],
    });
    const { observations } = await createTestRuntime(
        t,
        [Orchestrator],
        delegationResponses('fixture-worker', 'Inspect README.md', expected),
    );
    const handle = init(Orchestrator, { id: 'fixture-delegation' });
    const receipt = await handle.dispatch('Inspect the repository');
    assert.equal((await handle.read(receipt)).text, 'Delegation completed.');
    const tasks = observations.filter((event) => event.type === 'task');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.result, expected);
    assert.equal(tasks[0]?.isError, false);
});
