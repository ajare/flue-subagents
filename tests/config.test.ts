import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    ConfigurationError,
    DEFAULT_CONFIGURATION,
    configurationForDiagnostics,
    resolveConfiguration,
    resolveConfigurationSources,
    restrictedAgentEnvironment,
} from '../src/config.ts';
import {
    InfrastructureError,
    checkModelConnectivity,
    createModelProvider,
} from '../src/model-provider.ts';

test('configuration sources use CLI, environment, project, default precedence', () => {
    const resolved = resolveConfigurationSources({
        project: {
            model: 'project/model',
            contextWindow: 16_000,
            maxOutputTokens: 4_000,
            maxDelegations: 5,
            commandTimeoutMs: '2m',
        },
        env: {
            FLUE_AGENT_MODEL: 'environment/model',
            FLUE_AGENT_MAX_DELEGATIONS: '8',
            FLUE_AGENT_COMMAND_TIMEOUT: '3m',
            FLUE_AGENT_WORKSPACE_LIMIT: '2gib',
        },
        cli: { model: 'cli/model', maxDelegations: 13 },
    });

    assert.equal(resolved.model, 'cli/model');
    assert.equal(resolved.contextWindow, 16_000);
    assert.equal(resolved.maxDelegations, 13);
    assert.equal(resolved.commandTimeoutMs, 180_000);
    assert.equal(resolved.workspaceLimitBytes, 2 * 1024 ** 3);
    assert.equal(
        resolved.readOnlyConcurrency,
        DEFAULT_CONFIGURATION.readOnlyConcurrency,
    );
});

test('project configuration is loaded and validated before runtime setup', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'flue-config-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
        join(directory, 'flue-agent.config.json'),
        JSON.stringify({ retentionMs: '2d', reasoningEffort: 'medium' }),
    );

    const resolved = await resolveConfiguration({ cwd: directory, env: {} });
    assert.equal(resolved.retentionMs, 2 * 24 * 60 * 60 * 1_000);
    assert.equal(resolved.reasoningEffort, 'medium');

    await writeFile(join(directory, 'flue-agent.config.json'), '{');
    await assert.rejects(
        resolveConfiguration({ cwd: directory, env: {} }),
        ConfigurationError,
    );
});

test('invalid limits and endpoints fail clearly', () => {
    assert.throws(
        () => resolveConfigurationSources({ cli: { readOnlyConcurrency: 0 } }),
        /readOnlyConcurrency.*positive integer/u,
    );
    assert.throws(
        () =>
            resolveConfigurationSources({
                cli: { endpoint: 'file:///tmp/socket' },
            }),
        /HTTP\(S\)/u,
    );
    assert.throws(
        () =>
            resolveConfigurationSources({
                cli: { contextWindow: 100, maxOutputTokens: 101 },
            }),
        /cannot exceed/u,
    );
});

test('diagnostics contain effective non-secret values and command env is allowlisted', () => {
    const config = resolveConfigurationSources({});
    assert.deepEqual(configurationForDiagnostics(config), config);
    assert.deepEqual(
        restrictedAgentEnvironment({
            PATH: '/bin',
            LANG: 'C',
            API_TOKEN: 'secret',
            AWS_SECRET_ACCESS_KEY: 'secret',
        }),
        { PATH: '/bin', LANG: 'C' },
    );
});

test('configured provider preserves the model defaults', () => {
    const provider = createModelProvider(resolveConfigurationSources({}));
    const [model] = provider.getModels();
    assert.equal(provider.id, 'halogen');
    assert.equal(model?.id, 'qwen-3.8-flash-next');
    assert.equal(model?.baseUrl, 'http://localhost:8731/v1');
    assert.equal(model?.contextWindow, 262_144);
    assert.equal(model?.maxTokens, 65_536);
});

test('default provider request respects the local server output-token cap', async () => {
    const configuration = resolveConfigurationSources({});
    const provider = createModelProvider(configuration);
    const [model] = provider.getModels();
    assert.ok(model);
    let budget: unknown;
    const result = await provider
        .streamSimple(
            model,
            {
                messages: [
                    {
                        role: 'user',
                        content: 'Count C++ lines excluding submodules',
                        timestamp: 0,
                    },
                ],
            },
            {
                apiKey: 'local',
                reasoning: 'high',
                onPayload(payload) {
                    const request = payload as Record<string, unknown>;
                    budget =
                        request.max_tokens ?? request.max_completion_tokens;
                    // Stop before HTTP dispatch: this test never contacts a model server.
                    throw new Error('Captured request');
                },
            },
        )
        .result();
    assert.match(result.errorMessage ?? '', /Captured request/);
    assert.ok(
        typeof budget === 'number' && budget > 0 && budget <= 65_536,
        `max_tokens ${String(budget)} exceeds server cap 65536`,
    );
});

test('connectivity check reports endpoint failures as infrastructure errors', async () => {
    const configuration = resolveConfigurationSources({});
    let requestedUrl: string | undefined;
    await checkModelConnectivity(configuration, {
        fetch: async (input) => {
            requestedUrl = String(input);
            return new Response('{}', { status: 200 });
        },
    });
    assert.equal(requestedUrl, 'http://localhost:8731/v1/models');

    await assert.rejects(
        checkModelConnectivity(configuration, {
            fetch: async () =>
                new Response('offline', { status: 503, statusText: 'Offline' }),
        }),
        (error: unknown) =>
            error instanceof InfrastructureError &&
            error.code === 'model_unavailable' &&
            /503 Offline/u.test(error.message),
    );
});
