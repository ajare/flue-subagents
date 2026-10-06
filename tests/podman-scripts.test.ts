import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmod,
    mkdir,
    mkdtemp,
    realpath,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url)).replace(
    /\/$/u,
    '',
);

test('Podman scripts build and run from any directory with safely quoted arguments', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'flue-podman-'));
    try {
        const bin = join(temporary, 'bin');
        const repo = join(temporary, 'trusted repo');
        const state = join(temporary, 'private state');
        await mkdir(bin);
        await mkdir(repo);
        const podman = join(bin, 'podman');
        await writeFile(
            podman,
            `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
        );
        await chmod(podman, 0o755);
        const env = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            FLUE_PODMAN_IMAGE: 'test-agent:local',
            FLUE_PODMAN_STATE_DIR: state,
            FLUE_PODMAN_ENV_FILE: '',
            FLUE_AGENT_ENDPOINT: 'http://model:9000/v1',
            FLUE_AGENT_MODEL: 'test/model',
        };
        const invoke = (script: string, args: string[], overrides = {}) =>
            spawnSync('bash', [join(project, 'scripts', script), ...args], {
                cwd: temporary,
                env: { ...env, ...overrides },
                encoding: 'utf8',
            });

        const build = invoke('podman-build.sh', ['--no-cache']);
        assert.equal(build.status, 0, build.stderr);
        assert.deepEqual(JSON.parse(build.stdout), [
            'build',
            '--tag',
            'test-agent:local',
            '--no-cache',
            await realpath(project),
        ]);

        const prompt = '- Explain "quoted text"; $(touch unwanted)';
        const run = invoke('podman-run.sh', [repo, prompt, '--json']);
        assert.equal(run.status, 0, run.stderr);
        const args: string[] = JSON.parse(run.stdout);
        assert.deepEqual(args.slice(-4), [
            'test-agent:local',
            '--json',
            '--',
            prompt,
        ]);
        assert.ok(
            args.includes(
                `type=bind,source=${await realpath(repo)},target=/repo,relabel=private`,
            ),
        );
        assert.ok(
            args.includes(
                `type=bind,source=${await realpath(state)},target=/data,relabel=private`,
            ),
        );
        assert.equal(args[args.indexOf('--userns') + 1], 'keep-id');
        assert.ok(!args.includes('--add-host'));
        assert.ok(args.includes('FLUE_AGENT_ENDPOINT=http://model:9000/v1'));
        const defaults = invoke('podman-run.sh', [repo, 'Inspect'], {
            FLUE_AGENT_ENDPOINT: '',
            FLUE_AGENT_MODEL: '',
        });
        assert.equal(defaults.status, 0, defaults.stderr);
        assert.ok(
            JSON.parse(defaults.stdout).includes(
                'FLUE_AGENT_ENDPOINT=http://host.containers.internal:8731/v1',
            ),
        );
        assert.ok(args.includes('FLUE_AGENT_MODEL=test/model'));
        assert.equal((await stat(state)).mode & 0o777, 0o700);

        const envFile = join(temporary, 'credentials.env');
        await writeFile(envFile, 'CUSTOM_API_KEY=example\n');
        const withFile = invoke('podman-run.sh', [repo, 'Inspect'], {
            FLUE_PODMAN_ENV_FILE: envFile,
            FLUE_AGENT_ENDPOINT: '',
            FLUE_AGENT_MODEL: '',
        });
        assert.equal(withFile.status, 0, withFile.stderr);
        const fileArgs: string[] = JSON.parse(withFile.stdout);
        assert.equal(fileArgs[fileArgs.indexOf('--env-file') + 1], envFile);
        assert.ok(
            !fileArgs.some((arg) => arg.startsWith('FLUE_AGENT_ENDPOINT=')),
        );

        for (const invalid of [
            [],
            [repo],
            [repo, '   '],
            [join(temporary, 'missing'), 'Inspect'],
        ]) {
            const result = invoke('podman-run.sh', invalid);
            assert.equal(result.status, 2);
            assert.equal(result.stdout, '');
        }
        const nestedState = invoke('podman-run.sh', [repo, 'Inspect'], {
            FLUE_PODMAN_STATE_DIR: join(repo, 'state'),
        });
        assert.equal(nestedState.status, 2);
        assert.match(nestedState.stderr, /outside the repository/u);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});
