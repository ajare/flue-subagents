import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createModels } from '@earendil-works/pi-ai';
import {
    configurationForDiagnostics,
    resolveConfigurationSources,
    restrictedAgentEnvironment,
    subagentConfiguration,
} from '../src/config.ts';
import {
    checkModelConnectivity,
    createModelProvider,
    resolveApiKey,
} from '../src/model-provider.ts';
import { RunStore } from '../src/run-storage.ts';

test('shared and role credentials resolve named environment variables for connectivity and provider auth', async () => {
    const config = resolveConfigurationSources({
        project: {
            credentials: { type: 'apiKey', apiKeyEnv: 'SHARED_API_KEY' },
            subagents: {
                explorer: {
                    model: 'remote/model',
                    credentials: {
                        type: 'apiKey',
                        apiKeyEnv: 'EXPLORER_API_KEY',
                    },
                },
                planner: { model: 'remote/model' },
                reviewer: { credentials: { type: 'local' } },
            },
        },
    });
    const env = {
        SHARED_API_KEY: 'shared-secret',
        EXPLORER_API_KEY: 'explorer-secret',
    };
    for (const [configuration, expected] of [
        [config, 'shared-secret'],
        [subagentConfiguration(config, 'planner'), 'shared-secret'],
        [subagentConfiguration(config, 'explorer'), 'explorer-secret'],
        [subagentConfiguration(config, 'reviewer'), 'local'],
    ] as const) {
        await checkModelConnectivity(configuration, {
            env,
            fetch: async (_url, options) => {
                assert.equal(
                    new Headers(options?.headers).get('authorization'),
                    `Bearer ${expected}`,
                );
                return Response.json({ data: [] });
            },
        });
        const provider = createModelProvider(configuration, env);
        const models = createModels();
        models.setProvider(provider);
        assert.equal(
            (await models.getAuth(provider.id))?.auth.apiKey,
            expected,
        );
    }
    // Resolution is deferred until auth is requested and rereads the host environment.
    const provider = createModelProvider(config, env);
    env.SHARED_API_KEY = 'rotated-secret';
    const models = createModels();
    models.setProvider(provider);
    assert.equal(
        (await models.getAuth(provider.id))?.auth.apiKey,
        'rotated-secret',
    );
});

test('missing or empty keys fail without network calls or secret values in errors', async () => {
    const config = resolveConfigurationSources({
        project: { credentials: { type: 'apiKey', apiKeyEnv: 'MISSING_KEY' } },
    });
    for (const value of [undefined, '', '  ', 'secret\nvalue']) {
        let called = false;
        const env = { MISSING_KEY: value };
        await assert.rejects(
            checkModelConnectivity(config, {
                env,
                fetch: async () => {
                    called = true;
                    return Response.json({});
                },
            }),
            /MISSING_KEY/u,
        );
        assert.equal(called, false);
        assert.throws(
            () => resolveApiKey(config, env),
            (error) =>
                error instanceof Error && !error.message.includes('secret'),
        );
    }
    assert.equal(resolveApiKey(resolveConfigurationSources({}), {}), 'local');
});

test('credential declarations reject literal secrets, invalid environment names and sandbox variables', () => {
    for (const credentials of [
        null,
        'secret',
        { type: 'unknown' },
        { type: 'apiKey' },
        { type: 'apiKey', apiKey: 'secret' },
        { type: 'apiKey', apiKeyEnv: 'API-KEY' },
        { type: 'apiKey', apiKeyEnv: '' },
        { type: 'apiKey', apiKeyEnv: 'PATH' },
        { type: 'local', apiKey: 'secret' },
    ]) {
        assert.throws(() =>
            resolveConfigurationSources({
                project: JSON.parse(JSON.stringify({ credentials })),
            }),
        );
        assert.throws(() =>
            resolveConfigurationSources({
                project: JSON.parse(
                    JSON.stringify({
                        subagents: { explorer: { credentials } },
                    }),
                ),
            }),
        );
    }
});

test('snapshots and diagnostics store only references and sandbox environments exclude keys', async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'flue-credentials-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const config = resolveConfigurationSources({
        project: {
            credentials: { type: 'apiKey', apiKeyEnv: 'SHARED_API_KEY' },
            subagents: {
                explorer: {
                    credentials: {
                        type: 'apiKey',
                        apiKeyEnv: 'EXPLORER_API_KEY',
                    },
                },
            },
        },
    });
    const env = {
        SHARED_API_KEY: 'shared-secret',
        EXPLORER_API_KEY: 'explorer-secret',
        PATH: '/bin',
    };
    assert.deepEqual(restrictedAgentEnvironment(env), { PATH: '/bin' });
    await mkdir(join(cwd, 'repo'));
    const store = new RunStore({ root: join(cwd, 'state') });
    const run = await store.create({
        repository: join(cwd, 'repo'),
        configuration: config,
        conversationId: 'test',
    });
    const saved = await store.read(run.id);
    assert.deepEqual(saved.configuration, config);
    const diagnostics = JSON.stringify([
        saved,
        configurationForDiagnostics(config),
    ]);
    assert.ok(diagnostics.includes('EXPLORER_API_KEY'));
    assert.ok(!diagnostics.includes('shared-secret'));
    assert.ok(!diagnostics.includes('explorer-secret'));
});
