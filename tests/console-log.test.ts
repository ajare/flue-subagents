import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { ConsoleLog, type OutputStream } from '../src/console-log.ts';
import { runCli } from '../src/cli.ts';
import { createGitFixture } from './helpers/git.ts';
import { createMockProvider, TEST_MODEL } from './helpers/runtime.ts';

function capture() {
    let text = '';
    const stream: OutputStream = {
        write(chunk) {
            text += chunk.toString();
            return true;
        },
    };
    return { stream, text: () => text };
}

for (const json of [false, true]) {
    test(`CLI ${json ? 'JSON' : 'human'} output matches both invocation and run logs`, async (t) => {
        const repo = await createGitFixture(t);
        const root = join(dirname(repo.path), 'state');
        const stdout = capture();
        const stderr = capture();
        const model = createMockProvider([
            fauxAssistantMessage(
                fauxToolCall('submit_orchestrator_result', {
                    schemaVersion: 1,
                    status: 'completed',
                    summary: 'Finished ✓',
                    questions: [],
                    failureWaivers: [],
                }),
                { stopReason: 'toolUse' },
            ),
        ]);
        assert.equal(
            await runCli(
                [
                    ...(json ? ['--json'] : []),
                    '--repo',
                    repo.path,
                    'Explain the repository.',
                ],
                {
                    env: {
                        ...repo.env,
                        FLUE_AGENT_DATA_DIR: root,
                        FLUE_AGENT_MODEL: TEST_MODEL,
                    },
                    stdout: stdout.stream,
                    stderr: stderr.stream,
                    modelTransport: {
                        check: async () => {},
                        create: () => model.provider,
                    },
                },
            ),
            0,
        );
        const [invocation] = await readdir(join(root, 'logs'));
        const [run] = await readdir(join(root, 'runs'));
        assert.ok(invocation);
        assert.ok(run);
        for (const directory of [
            join(root, 'logs', invocation),
            join(root, 'runs', run),
        ]) {
            assert.equal(
                await readFile(join(directory, 'stdout.log'), 'utf8'),
                stdout.text(),
            );
            assert.equal(
                await readFile(join(directory, 'stderr.log'), 'utf8'),
                stderr.text(),
            );
        }
        assert.match(stdout.text(), /Finished ✓/);
        assert.match(stderr.text(), /TRUSTED-LOCAL/);
    });
}

test('pre-run errors are retained even without a run directory', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'console-error-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stderr = capture();
    assert.equal(
        await runCli(['--unknown'], {
            env: { FLUE_AGENT_DATA_DIR: root },
            stderr: stderr.stream,
            stdout: capture().stream,
        }),
        1,
    );
    const [invocation] = await readdir(join(root, 'logs'));
    assert.ok(invocation);
    assert.equal(
        await readFile(join(root, 'logs', invocation, 'stderr.log'), 'utf8'),
        stderr.text(),
    );
    assert.match(stderr.text(), /flue-agent:/);
});

test('tee preserves bytes, callback/backpressure, and appends resumed transcripts', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'console-tee-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = join(root, 'run');
    await mkdir(run);
    let called = false;
    const stream: OutputStream = {
        write(
            _chunk,
            encodingOrCallback?: unknown,
            callback?: (error?: Error | null) => void,
        ) {
            if (typeof encodingOrCallback === 'function') encodingOrCallback();
            else callback?.();
            return false;
        },
    };
    const first = new ConsoleLog(root);
    const stdout = first.tee('stdout', stream);
    assert.equal(
        stdout.write('before', () => {
            called = true;
        }),
        false,
    );
    assert.equal(called, true);
    first.attachRun(run);
    first.attachRun(run);
    stdout.write('e9', 'hex');
    first.close();
    const resumed = new ConsoleLog(root);
    resumed.tee('stdout', stream).write('after');
    resumed.attachRun(run);
    resumed.close();
    assert.deepEqual(
        await readFile(join(run, 'stdout.log')),
        Buffer.concat([
            Buffer.from('before'),
            Buffer.from([0xe9]),
            Buffer.from('after'),
        ]),
    );
});

test('real process writes and console diagnostics are captured and streams restored', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'console-process-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    execFileSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `
        import { ConsoleLog } from ${JSON.stringify(new URL('../src/console-log.ts', import.meta.url).href)};
        const log = new ConsoleLog(${JSON.stringify(root)});
        const out = process.stdout.write, err = process.stderr.write;
        log.tee('stdout', process.stdout);
        log.tee('stderr', process.stderr);
        console.log('dependency stdout');
        console.error('dependency stderr');
        process.stderr.write('direct stderr');
        log.close();
        if (out !== process.stdout.write || err !== process.stderr.write) process.exit(1);
    `,
        ],
        { stdio: 'pipe' },
    );
    const [invocation] = await readdir(join(root, 'logs'));
    assert.ok(invocation);
    assert.equal(
        await readFile(join(root, 'logs', invocation, 'stdout.log'), 'utf8'),
        'dependency stdout\n',
    );
    assert.equal(
        await readFile(join(root, 'logs', invocation, 'stderr.log'), 'utf8'),
        'dependency stderr\ndirect stderr',
    );
});
