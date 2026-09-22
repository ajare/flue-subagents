// src/local-provider.ts

import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import { setProvider } from '@flue/runtime';

setProvider(
    createProvider({
        id: 'local',

        auth: {
            apiKey: {
                name: 'Local llama.cpp',
                resolve: async () => ({
                    auth: {
                        apiKey: 'local',
                    },
                }),
            },
        },

        models: [
            {
                id: 'ornith',

                name: 'Local Ornith 1.5',

                provider: 'local',
                api: 'openai-completions',

                baseUrl: 'http://localhost:8080/v1',

                reasoning: true,

                input: ['text'],

                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                },

                // Set these to your actual model/server configuration.
                contextWindow: 262144,
                maxTokens: 262144,
            },
        ],

        api: openAICompletionsApi(),
    }),
);
