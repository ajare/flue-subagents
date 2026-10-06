import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    resolveConfiguration,
    resolveConfigurationSources,
    subagentConfiguration,
} from '../src/config.ts';
import { RunStore } from '../src/run-storage.ts';

const project = {
    models: {
        remote: {
            model: 'openrouter/openai/example',
            endpoint: 'https://openrouter.ai/api/v1',
            credentials: {
                type: 'apiKey' as const,
                apiKeyEnv: 'REMOTE_API_KEY',
            },
            reasoningEffort: 'default' as const,
            openRouterProviders: ['openai'],
        },
        shared: {
            model: 'local/shared',
            endpoint: 'http://localhost:9001/v1',
            credentials: { type: 'local' as const },
            contextWindow: 32000,
            maxOutputTokens: 8000,
            reasoningEffort: 'off' as const,
        },
    },
    orchestrator: 'remote',
    subagents: {
        explorer: 'shared',
        planner: 'shared',
        implementer: 'shared',
        reviewer: 'shared',
    },
    maxDelegations: 12,
} as const;

test('named definitions expand into independent role settings with existing source precedence', () => {
    const resolved = resolveConfigurationSources({
        project,
        env: { FLUE_AGENT_MODEL: 'override/root' },
        cli: { maxDelegations: 9 },
    });
    assert.equal(resolved.model, 'override/root');
    assert.equal(resolved.maxDelegations, 9);
    assert.equal(resolved.endpoint, project.models.remote.endpoint);
    assert.deepEqual(resolved.credentials, project.models.remote.credentials);
    for (const role of [
        'explorer',
        'planner',
        'implementer',
        'reviewer',
    ] as const) {
        const settings = subagentConfiguration(resolved, role);
        assert.equal(settings.model, `flue-${role}/shared`);
        assert.equal(settings.contextWindow, 32000);
        assert.equal(settings.maxOutputTokens, 8000);
        assert.equal(settings.endpoint, project.models.shared.endpoint);
        assert.deepEqual(settings.credentials, { type: 'local' });
    }
    assert.notEqual(resolved.subagents?.explorer, resolved.subagents?.planner);
    assert.ok(Object.isFrozen(resolved.subagents?.explorer));
    assert.equal('models' in resolved, false);
    assert.equal('orchestrator' in resolved, false);
});

test('alternate named config files are loaded and snapshots survive later file edits', async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'flue-named-models-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, 'repo'));
    const configPath = join(cwd, 'custom.json');
    await writeFile(configPath, JSON.stringify(project));
    const config = await resolveConfiguration({ configPath, env: {} });
    const store = new RunStore({ root: join(cwd, 'state') });
    const run = await store.create({
        repository: join(cwd, 'repo'),
        configuration: config,
        conversationId: 'test',
    });
    await writeFile(
        configPath,
        JSON.stringify({ models: {}, orchestrator: 'missing' }),
    );
    assert.deepEqual((await store.read(run.id)).configuration, config);
    await assert.rejects(
        resolveConfiguration({ configPath, env: {} }),
        /Unknown model definition/u,
    );
});

test('unknown references and malformed named definitions fail clearly', () => {
    const invalid = [
        { models: null },
        { models: { bad: null } },
        { models: { 'invalid name': {} } },
        { models: { bad: { typo: 1 } } },
        { models: { bad: { endpoint: 'file:///tmp' } } },
        { models: { bad: { model: 'missing-provider' } } },
        { models: { bad: { contextWindow: 100, maxOutputTokens: 101 } } },
        {
            models: {
                bad: { credentials: { type: 'apiKey', apiKey: 'secret' } },
            },
        },
        { models: {}, orchestrator: 'missing' },
        { models: {}, subagents: { explorer: 'missing' } },
        { orchestrator: 'missing' },
        { models: { shared: {} }, orchestrator: { model: 'shared' } },
        {
            models: { shared: {} },
            orchestrator: 'shared',
            model: 'local/ambiguous',
        },
    ];
    for (const input of invalid) {
        assert.throws(() =>
            resolveConfigurationSources({
                project: JSON.parse(JSON.stringify(input)),
            }),
        );
    }
    // Looking up a missing name must not find inherited Object.prototype properties.
    assert.throws(
        () =>
            resolveConfigurationSources({
                project: { models: {}, orchestrator: 'constructor' },
            }),
        /Unknown model definition/u,
    );
});

test('legacy inline settings can coexist with named specialist references', () => {
    const config = resolveConfigurationSources({
        project: {
            model: 'local/root',
            models: { shared: { model: 'local/child' } },
            subagents: {
                explorer: 'shared',
                reviewer: { model: 'local/review' },
            },
        },
    });
    assert.equal(config.model, 'local/root');
    assert.equal(config.subagents?.explorer?.model, 'local/child');
    assert.equal(config.subagents?.reviewer?.model, 'local/review');
});
