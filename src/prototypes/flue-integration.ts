import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
    type FauxResponseFactory,
} from '@earendil-works/pi-ai';
import {
    AgentRunError,
    defineSubagent,
    init,
    observe,
    useModel,
    useSubagent,
    type FlueObservation,
} from '@flue/runtime';
import { start } from '@flue/runtime/node';

function ProbeWorker() {
    return 'Return a concise result for the independent probe task.';
}

const probeWorker = defineSubagent({
    name: 'probe-worker',
    description: 'Executes one independent probe task.',
    agent: ProbeWorker,
});

function IntegrationProbeAgent() {
    useModel('flue-probe/model');
    useSubagent(probeWorker);

    return 'Delegate independent work in one parallel task-tool batch.';
}

export interface FlueIntegrationProbeReport {
    parallelDelegation: {
        maximumConcurrentChildren: number;
        taskIds: string[];
        taskResults: string[];
    };
    cancellation: {
        outcome: 'aborted';
        submissionId: string;
    };
    continuation: {
        conversationId: string;
        originalUid: string;
        continuedUid: string;
        reply: string;
    };
    observedEventTypes: string[];
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(
                    signal.reason ?? new DOMException('Aborted', 'AbortError'),
                );
            },
            { once: true },
        );
    });
}

/**
 * Exercises the Flue APIs selected by ADR 0001 without requiring a model
 * server. It throws when any integration assumption no longer holds.
 */
export async function runFlueIntegrationProbe(): Promise<FlueIntegrationProbeReport> {
    const provider = fauxProvider({
        provider: 'flue-probe',
        models: [{ id: 'model', reasoning: false }],
    });
    const observations: FlueObservation[] = [];
    const unsubscribe = observe((event) => {
        observations.push(event);
    });

    let activeChildren = 0;
    let maximumConcurrentChildren = 0;
    const childResponse =
        (label: string): FauxResponseFactory =>
        async (_context, options) => {
            activeChildren += 1;
            maximumConcurrentChildren = Math.max(
                maximumConcurrentChildren,
                activeChildren,
            );
            await delay(30, options?.signal);
            activeChildren -= 1;
            return fauxAssistantMessage(fauxText(`${label} result`));
        };

    const runtime = await start({
        agents: [IntegrationProbeAgent],
        providers: [provider.provider],
    });

    try {
        provider.setResponses([
            fauxAssistantMessage(
                [
                    fauxToolCall('task', {
                        agent: 'probe-worker',
                        prompt: 'Inspect independent area alpha.',
                    }),
                    fauxToolCall('task', {
                        agent: 'probe-worker',
                        prompt: 'Inspect independent area beta.',
                    }),
                ],
                { stopReason: 'toolUse' },
            ),
            childResponse('alpha'),
            childResponse('beta'),
            fauxAssistantMessage(fauxText('Parallel delegation completed.')),
        ]);

        const parallel = init(IntegrationProbeAgent, {
            id: 'parallel-delegation',
        });
        const parallelReceipt = await parallel.dispatch(
            'Run the two independent probes concurrently.',
        );
        const parallelReply = await parallel.read(parallelReceipt);

        assert.equal(parallelReply.text, 'Parallel delegation completed.');
        assert.equal(
            maximumConcurrentChildren,
            2,
            'task calls from one model batch must overlap',
        );

        let markCancellationStarted: (() => void) | undefined;
        const cancellationStarted = new Promise<void>((resolve) => {
            markCancellationStarted = resolve;
        });
        const blockedResponse: FauxResponseFactory = async (
            _context,
            options,
        ) => {
            markCancellationStarted?.();
            await delay(30_000, options?.signal);
            return fauxAssistantMessage('unexpected completion');
        };
        provider.setResponses([blockedResponse]);

        const cancellable = init(IntegrationProbeAgent, {
            id: 'cancel-and-continue',
        });
        const cancelledReceipt = await cancellable.dispatch(
            'Wait for cancellation.',
        );
        await cancellationStarted;
        await cancellable.abort();

        let cancellationOutcome: 'aborted' | undefined;
        try {
            await cancellable.read(cancelledReceipt);
        } catch (error) {
            assert.ok(error instanceof AgentRunError);
            assert.equal(error.outcome, 'aborted');
            cancellationOutcome = error.outcome;
        }
        assert.equal(cancellationOutcome, 'aborted');

        provider.setResponses([
            fauxAssistantMessage(fauxText('Continued after cancellation.')),
        ]);
        const continuedReceipt = await cancellable.dispatch(
            'Continue in the same conversation.',
        );
        const continuedReply = await cancellable.read(continuedReceipt);

        assert.equal(continuedReceipt.uid, cancelledReceipt.uid);
        assert.equal(continuedReply.text, 'Continued after cancellation.');

        const taskEvents = observations.filter(
            (event): event is FlueObservation & { type: 'task' } =>
                event.type === 'task',
        );
        assert.equal(taskEvents.length, 2);
        assert.ok(taskEvents.every((event) => event.isError === false));

        return {
            parallelDelegation: {
                maximumConcurrentChildren,
                taskIds: taskEvents.map((event) => event.taskId),
                taskResults: taskEvents.map((event) => String(event.result)),
            },
            cancellation: {
                outcome: cancellationOutcome,
                submissionId: cancelledReceipt.submissionId,
            },
            continuation: {
                conversationId: cancellable.id,
                originalUid: cancelledReceipt.uid,
                continuedUid: continuedReceipt.uid,
                reply: continuedReply.text,
            },
            observedEventTypes: [
                ...new Set(observations.map((event) => event.type)),
            ],
        };
    } finally {
        unsubscribe();
        await runtime.stop();
    }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
    const report = await runFlueIntegrationProbe();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
