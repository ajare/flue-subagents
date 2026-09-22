import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    type FauxResponseStep,
} from '@earendil-works/pi-ai';
import { observe, type FlueObservation } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import type { TestContext } from 'node:test';

export const TEST_MODEL = 'flue-test/model';

export function createMockProvider(responses: FauxResponseStep[] = []) {
    const provider = fauxProvider({
        provider: 'flue-test',
        models: [{ id: 'model', reasoning: false }],
    });
    provider.setResponses(responses);
    return provider;
}

/** Script a real task-tool delegation followed by its child and parent answers. */
export function delegationResponses(
    agent: string,
    prompt: string,
    result: string,
) {
    return [
        fauxAssistantMessage(fauxToolCall('task', { agent, prompt }), {
            stopReason: 'toolUse',
        }),
        fauxAssistantMessage(result),
        fauxAssistantMessage('Delegation completed.'),
    ];
}

/** Real embedded Flue runtime with only an in-memory model/provider adapter. */
export async function createTestRuntime(
    t: TestContext,
    agents: Parameters<typeof start>[0]['agents'],
    responses: FauxResponseStep[],
) {
    const model = createMockProvider(responses);
    const observations: FlueObservation[] = [];
    const unsubscribe = observe((event) => {
        observations.push(event);
    });
    t.after(unsubscribe);
    const runtime = await start({ agents, providers: [model.provider] });
    t.after(() => runtime.stop());
    return { runtime, model, observations };
}
