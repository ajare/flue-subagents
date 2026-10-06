import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from '@earendil-works/pi-ai';
import { init, observe } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { createOrchestrator } from '../src/agents/orchestrator.ts';
import { parseCliArguments, runCli } from '../src/cli.ts';
import { createGitFixture } from './helpers/git.ts';
import {
    resolveConfiguration,
    resolveConfigurationSources,
    subagentConfiguration,
} from '../src/config.ts';
import { createModelProvider } from '../src/model-provider.ts';
import { RunStore } from '../src/run-storage.ts';

test('default file and explicit replacement file select per-role settings', async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'flue-role-config-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const storage = await mkdtemp(join(tmpdir(), 'flue-role-storage-'));
    t.after(() => rm(storage, { recursive: true, force: true }));
    await writeFile(
        join(cwd, 'flue-agent.config.json'),
        JSON.stringify({ subagents: { explorer: { model: 'local/explore' } } }),
    );
    await writeFile(
        join(cwd, 'alternate.json'),
        JSON.stringify({
            subagents: {
                reviewer: {
                    model: 'local/review',
                    endpoint: 'http://localhost:9000/v1',
                    reasoningEffort: 'off',
                },
            },
        }),
    );
    const defaults = await resolveConfiguration({ cwd, env: {} });
    assert.equal(
        subagentConfiguration(defaults, 'explorer').model,
        'flue-explorer/explore',
    );
    assert.equal(
        subagentConfiguration(defaults, 'planner').model,
        defaults.model,
    );
    for (const args of [
        ['--config', 'alternate.json'],
        ['--config=alternate.json'],
    ]) {
        const parsed = parseCliArguments([...args, 'task'], cwd);
        const config = await resolveConfiguration({
            cwd,
            env: {},
            configPath: parsed.configPath,
        });
        assert.equal(config.subagents?.explorer, undefined);
        const reviewer = subagentConfiguration(config, 'reviewer');
        const provider = createModelProvider(reviewer);
        assert.equal(provider.id, 'flue-reviewer');
        assert.equal(
            provider.getModels()[0]?.baseUrl,
            'http://localhost:9000/v1',
        );
        assert.equal(provider.getModels()[0]?.reasoning, false);
        const store = new RunStore({ root: storage });
        const run = await store.create({
            repository: cwd,
            configuration: config,
            conversationId: 'test',
        });
        assert.deepEqual((await store.read(run.id)).configuration, config);
    }
    await assert.rejects(
        resolveConfiguration({
            cwd,
            env: {},
            configPath: join(cwd, 'missing.json'),
        }),
        /Unable to read/u,
    );
    assert.throws(
        () => parseCliArguments(['--config'], cwd),
        /requires a path/u,
    );
});

test('CLI passes an explicit config file through to the execution request', async (t) => {
    const repo = await createGitFixture(t);
    const cwd = await mkdtemp(join(tmpdir(), 'flue-override-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(
        join(cwd, 'models.json'),
        JSON.stringify({ subagents: { planner: { model: 'local/planning' } } }),
    );
    let executed = false;
    const code = await runCli(
        ['--repo', repo.path, '--config', 'models.json', 'Plan a change'],
        {
            cwd,
            env: { ...repo.env, XDG_STATE_HOME: join(cwd, 'state') },
            stdout: { write: () => true },
            stderr: { write: () => true },
            execute: async (request) => {
                executed = true;
                assert.equal(
                    request.configuration.subagents?.planner?.model,
                    'local/planning',
                );
                return 'Done';
            },
        },
    );
    assert.equal(code, 0);
    assert.ok(executed);
});

test('role configuration validates roles, fields, endpoints and effective budgets', () => {
    for (const subagents of [
        { unknown: {} },
        { explorer: null },
        { explorer: { typo: 10 } },
        { explorer: { model: 'bad' } },
        { explorer: { endpoint: 'file:///tmp' } },
        { explorer: { contextWindow: 100 } },
        { explorer: { maxOutputTokens: 0 } },
    ]) {
        assert.throws(() =>
            resolveConfigurationSources({
                project: JSON.parse(JSON.stringify({ subagents })),
            }),
        );
    }
    const config = resolveConfigurationSources({
        project: {
            subagents: {
                explorer: { endpoint: 'http://localhost:9001/v1' },
                reviewer: { endpoint: 'http://localhost:9002/v1' },
            },
        },
        env: { FLUE_AGENT_MODEL: 'local/shared' },
    });
    assert.equal(
        subagentConfiguration(config, 'explorer').model,
        'flue-explorer/shared',
    );
    assert.equal(
        subagentConfiguration(config, 'reviewer').model,
        'flue-reviewer/shared',
    );
});

test('real Flue delegation routes a specialist to its separate provider', async (t) => {
    const config = resolveConfigurationSources({
        project: {
            models: {
                root: { model: 'root/model' },
                specialist: {
                    model: 'other/specialist',
                    reasoningEffort: 'off',
                },
            },
            orchestrator: 'root',
            subagents: { explorer: 'specialist' },
        },
    });
    const root = fauxProvider({
        provider: 'root',
        models: [{ id: 'model', reasoning: false }],
    });
    const child = fauxProvider({
        provider: 'flue-explorer',
        models: [{ id: 'specialist', reasoning: false }],
    });
    root.setResponses([
        fauxAssistantMessage(
            fauxToolCall('task', {
                agent: 'explorer',
                prompt: 'Objective: inspect configuration. Role task: find settings. Acceptance criteria: None. Constraints: None. Evidence: None. Prior findings: None.',
            }),
            { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
            fauxToolCall('submit_orchestrator_result', {
                schemaVersion: 1,
                status: 'completed',
                summary: 'Done.',
                questions: [],
            }),
            { stopReason: 'toolUse' },
        ),
    ]);
    child.setResponses([
        fauxAssistantMessage(
            fauxToolCall('submit_specialist_result', {
                schemaVersion: 1,
                role: 'explorer',
                summary: 'Found settings.',
                findings: [],
                evidence: [],
                openQuestions: [],
            }),
            { stopReason: 'toolUse' },
        ),
    ]);
    const models: string[] = [];
    const dispose = observe((event) => {
        if (event.type === 'turn_request')
            models.push(event.request.requestedModel);
    });
    t.after(dispose);
    const agent = createOrchestrator({ configuration: config });
    const runtime = await start({
        agents: [agent],
        providers: [root.provider, child.provider],
    });
    t.after(() => runtime.stop());
    const handle = init(agent);
    await handle.read(await handle.dispatch('Explore the configuration.'));
    assert.ok(models.includes('specialist'), JSON.stringify(models));
    assert.ok(models.includes('model'));
});
