import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    HELP,
    type ExecutionRequest,
    createExecutionRequest,
    parseCliArguments,
    runCli,
} from '../src/cli.ts';
import { createGitFixture } from './helpers/git.ts';

async function* input(value: string) {
    yield value.slice(0, 3);
    yield value.slice(3);
}

function output() {
    let value = '';
    return {
        stream: {
            write: (chunk: string | Uint8Array) => {
                value += chunk;
                return true;
            },
        },
        read: () => value,
    };
}

test('argument and chunked stdin prompts create equivalent requests', async (t) => {
    const fixture = await createGitFixture(t);
    const repository = fixture.path;
    const requests: ExecutionRequest[] = [];
    const execute = async (request: ExecutionRequest) => {
        requests.push(request);
        return undefined;
    };

    assert.equal(
        await runCli(['--repo', repository, 'update the docs'], { execute }),
        0,
    );
    assert.equal(
        await runCli(['--repo', repository], {
            stdin: input('update the docs\n'),
            execute,
        }),
        0,
    );
    assert.deepEqual(requests[0], requests[1]);
});

test('empty positional and stdin prompts fail clearly without execution', async (t) => {
    const repository = await mkdtemp(join(tmpdir(), 'flue-cli-'));
    t.after(() => rm(repository, { recursive: true, force: true }));
    const stderr = output();
    let calls = 0;
    const execute = async () => {
        calls += 1;
        return undefined;
    };

    assert.equal(
        await runCli(['--repo', repository, '  '], {
            stderr: stderr.stream,
            execute,
        }),
        1,
    );
    assert.equal(
        await runCli(['--repo', repository], {
            stdin: input(' \n'),
            stderr: stderr.stream,
            execute,
        }),
        1,
    );
    assert.match(stderr.read(), /prompt is required/u);
    assert.equal(calls, 0);
});

test('repository paths are canonicalized before configuration and execution', async (t) => {
    const fixture = await createGitFixture(t);
    const alias = join(fixture.path, '..', 'alias');
    await symlink(fixture.path, alias);

    const request = await createExecutionRequest({
        repo: alias,
        prompt: 'work',
        env: fixture.env,
    });
    assert.equal(request.repository, fixture.path);
});

test('dirty repositories are rejected before execution unless explicitly allowed', async (t) => {
    const fixture = await createGitFixture(t);
    await fixture.write('new.txt', 'dirty\n');
    const stderr = output();
    let calls = 0;
    const execute = async (request: ExecutionRequest) => {
        calls += 1;
        assert.equal(request.repositoryState.clean, false);
        return undefined;
    };

    assert.equal(
        await runCli(['--repo', fixture.path, 'work'], {
            env: fixture.env,
            stderr: stderr.stream,
            execute,
        }),
        1,
    );
    assert.equal(calls, 0);
    assert.match(stderr.read(), /--allow-dirty/u);

    assert.equal(
        await runCli(['--allow-dirty', '--repo', fixture.path, 'work'], {
            env: fixture.env,
            execute,
        }),
        0,
    );
    assert.equal(calls, 1);
});

test('help, version and argument failures use conventional streams and statuses', async () => {
    const stdout = output();
    const stderr = output();
    assert.equal(await runCli(['--help'], { stdout: stdout.stream }), 0);
    assert.equal(stdout.read(), HELP);
    assert.match(stdout.read(), /trusted-local operation/u);
    assert.match(stdout.read(), /printf/u);

    const version = output();
    assert.equal(
        await runCli(['--version'], {
            stdout: version.stream,
            version: '1.2.3',
        }),
        0,
    );
    assert.equal(version.read(), '1.2.3\n');

    assert.equal(await runCli(['--unknown'], { stderr: stderr.stream }), 1);
    assert.match(stderr.read(), /Unknown option/u);
    assert.throws(() => parseCliArguments(['one', 'two']), /one prompt/u);
});
