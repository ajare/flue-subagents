import assert from 'node:assert/strict';
import test from 'node:test';
import {
    resolveConfiguration,
    resolveConfigurationSources,
    subagentConfiguration,
} from '../src/config.ts';
import { createModelProvider } from '../src/model-provider.ts';

test('checked-in orchestrator config selects OpenRouter and preserves local specialists', async () => {
    const config = await resolveConfiguration({ env: {} });
    assert.equal(config.model, 'openrouter/openai/gpt-6.1-sol');
    assert.equal(config.endpoint, 'https://openrouter.ai/api/v1');
    assert.deepEqual(config.credentials, {
        type: 'apiKey',
        apiKeyEnv: 'OPENROUTER_API_KEY',
    });
    assert.equal(config.reasoningEffort, 'default');
    assert.deepEqual(config.openRouterProviders, ['openai']);
    for (const role of [
        'explorer',
        'planner',
        'implementer',
        'reviewer',
    ] as const) {
        const settings = subagentConfiguration(config, role);
        assert.equal(settings.endpoint, 'http://localhost:8731/v1');
        assert.deepEqual(settings.credentials, { type: 'local' });
        assert.equal(settings.reasoningEffort, 'high');
        const compat = createModelProvider(settings).getModels()[0]?.compat;
        assert.equal(
            compat && 'openRouterRouting' in compat
                ? compat.openRouterRouting
                : undefined,
            undefined,
        );
    }
});

test('OpenRouter requests pin the OpenAI provider and enable default reasoning without effort', async () => {
    const config = await resolveConfiguration({ env: {} });
    const provider = createModelProvider(config, {
        OPENROUTER_API_KEY: 'test-key',
    });
    const [model] = provider.getModels();
    assert.ok(model);
    assert.equal(model.id, 'openai/gpt-6.1-sol');
    for (const simple of [true, false]) {
        let captured: Record<string, unknown> | undefined;
        const options = {
            apiKey: 'test-key',
            reasoning: 'high' as const,
            reasoningEffort: 'high' as const,
            onPayload(payload: unknown) {
                captured = payload as Record<string, unknown>;
                throw new Error('Offline payload captured');
            },
        };
        const context = {
            messages: [
                { role: 'user' as const, content: 'Hello', timestamp: 0 },
            ],
        };
        const result = await (simple
            ? provider.streamSimple(model, context, options)
            : provider.stream(model, context, options)
        ).result();
        assert.match(result.errorMessage ?? '', /Offline payload captured/u);
        assert.ok(captured);
        assert.equal(captured.model, 'openai/gpt-6.1-sol');
        assert.deepEqual(captured.provider, {
            only: ['openai'],
            allow_fallbacks: false,
        });
        assert.deepEqual(captured.reasoning, { enabled: true });
        assert.equal(captured.reasoning_effort, undefined);
    }
});

test('provider pin declarations reject empty or malformed lists', () => {
    for (const openRouterProviders of [[], 'openai', [3], [''], ['bad slug']]) {
        assert.throws(
            () =>
                resolveConfigurationSources({
                    project: JSON.parse(
                        JSON.stringify({ openRouterProviders }),
                    ),
                }),
            /provider slugs/u,
        );
    }
});
