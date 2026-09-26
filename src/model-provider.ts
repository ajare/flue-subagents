import { createProvider, type Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import type { AgentConfiguration } from './config.ts';
import { statsFetch } from './provider-stats.ts';

export interface ConnectivityCheckOptions {
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
}

export class InfrastructureError extends Error {
    readonly code = 'model_unavailable';
    readonly endpoint: string;

    constructor(message: string, endpoint: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'InfrastructureError';
        this.endpoint = endpoint;
    }
}

/** Build the OpenAI-compatible provider selected by the effective config. */
export function createModelProvider(
    configuration: AgentConfiguration,
): Provider {
    const { providerId, modelId } = splitModelSpecifier(configuration.model);
    const api = openAICompletionsApi();

    return createProvider({
        id: providerId,
        name: providerId === 'local' ? 'Local model server' : providerId,
        auth: {
            apiKey: {
                name: `${providerId} OpenAI-compatible endpoint`,
                resolve: async () => ({ auth: { apiKey: 'local' } }),
            },
        },
        models: [
            {
                id: modelId,
                name: modelId,
                provider: providerId,
                api: 'openai-completions',
                baseUrl: withoutTrailingSlash(configuration.endpoint),
                reasoning: configuration.reasoningEffort !== 'off',
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: configuration.contextWindow,
                maxTokens: configuration.maxOutputTokens,
            },
        ],
        api: {
            stream(model, context, options) {
                return api.stream(model, context, { ...options, fetch: statsFetch(options?.fetch) });
            },
            streamSimple(model, context, options) {
                return api.streamSimple(model, context, { ...options, fetch: statsFetch(options?.fetch) });
            },
        },
    });
}

/**
 * Verify the model endpoint before any run workspace is created. The standard
 * OpenAI model-list route is deliberately read-only and does not spend tokens.
 */
export async function checkModelConnectivity(
    configuration: AgentConfiguration,
    options: ConnectivityCheckOptions = {},
): Promise<void> {
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    const modelsUrl = `${withoutTrailingSlash(configuration.endpoint)}/models`;
    const timeoutController = new AbortController();
    const timeout = setTimeout(
        () =>
            timeoutController.abort(new Error('connectivity check timed out')),
        configuration.connectivityTimeoutMs,
    );
    const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal;

    try {
        const response = await fetchImplementation(modelsUrl, {
            method: 'GET',
            headers: {
                authorization: 'Bearer local',
                accept: 'application/json',
            },
            signal,
        });
        if (!response.ok) {
            throw new InfrastructureError(
                `Model endpoint connectivity check failed: ${response.status} ${response.statusText}`,
                configuration.endpoint,
            );
        }
    } catch (error) {
        if (error instanceof InfrastructureError) throw error;
        const detail = signal.aborted
            ? 'timed out or was cancelled'
            : errorMessage(error);
        throw new InfrastructureError(
            `Cannot connect to model endpoint ${configuration.endpoint}: ${detail}`,
            configuration.endpoint,
            { cause: error },
        );
    } finally {
        clearTimeout(timeout);
    }
}

export function splitModelSpecifier(specifier: string): {
    providerId: string;
    modelId: string;
} {
    const separator = specifier.indexOf('/');
    if (separator < 1 || separator === specifier.length - 1) {
        throw new TypeError('Model specifier must use provider/model form');
    }
    return {
        providerId: specifier.slice(0, separator),
        modelId: specifier.slice(separator + 1),
    };
}

function withoutTrailingSlash(value: string): string {
    return value.replace(/\/+$/u, '');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
