import { randomUUID } from 'node:crypto';
import type {
    AssistantMessage,
    AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import type { ResultCorrection } from './result-correction.ts';

interface ModelStream extends AsyncIterable<AssistantMessageEvent> {
    result(): Promise<AssistantMessage>;
}

/**
 * Buffer specialist turns so the durable stream and final message agree. Merely
 * replacing result() violates Flue's canonical block/tool-call identity rules.
 * Keep only the final message, not every growing partial snapshot. Usage remains
 * unchanged, and no length-stopped repository tool is ever executed.
 */
export function recoverTruncatedStream(
    stream: ModelStream,
    correction: ResultCorrection,
    limit: number,
): ModelStream {
    let prepared: Promise<AssistantMessage> | undefined;
    function prepare() {
        if (prepared) return prepared;
        prepared = (async () => {
            for await (const _event of stream) {
                /* Drain without retaining partial snapshots. */
            }
            const original = await stream.result();
            correction.completion = {
                stopReason: original.stopReason,
                outputTokens: original.usage.output,
            };
            if (original.stopReason !== 'length') return original;
            const hasTools = original.content.some(
                (block) => block.type === 'toolCall',
            );
            const text = original.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('');
            // Provider salvage can produce schema-valid but incomplete arguments.
            correction.retainTruncated(
                hasTools ? undefined : text,
                limit,
                original.usage.output,
            );
            return {
                ...original,
                stopReason: 'toolUse' as const,
                content: [
                    {
                        type: 'toolCall' as const,
                        id: randomUUID(),
                        name: 'submit_specialist_result',
                        arguments: {},
                    },
                ],
            };
        })();
        return prepared;
    }
    return {
        async *[Symbol.asyncIterator]() {
            yield* completedEvents(await prepare());
        },
        result: prepare,
    };
}

/** Replay complete blocks with consistent IDs, signatures, and final metadata. */
function* completedEvents(
    message: AssistantMessage,
): Generator<AssistantMessageEvent> {
    const partial = (
        content: AssistantMessage['content'],
    ): AssistantMessage => ({ ...message, stopReason: 'pending', content });
    yield { type: 'start', partial: partial([]) };
    for (const [contentIndex, block] of message.content.entries()) {
        const before = message.content.slice(0, contentIndex);
        const full = partial([...before, block]);
        if (block.type === 'text') {
            yield {
                type: 'text_start',
                contentIndex,
                partial: partial([...before, { ...block, text: '' }]),
            };
            yield {
                type: 'text_delta',
                contentIndex,
                delta: block.text,
                partial: full,
            };
            yield {
                type: 'text_end',
                contentIndex,
                content: block.text,
                partial: full,
            };
        } else if (block.type === 'thinking') {
            yield {
                type: 'thinking_start',
                contentIndex,
                partial: partial([...before, { ...block, thinking: '' }]),
            };
            yield {
                type: 'thinking_delta',
                contentIndex,
                delta: block.thinking,
                partial: full,
            };
            yield {
                type: 'thinking_end',
                contentIndex,
                content: block.thinking,
                partial: full,
            };
        } else if (block.type === 'toolCall') {
            yield {
                type: 'toolcall_start',
                contentIndex,
                partial: partial([...before, { ...block, arguments: {} }]),
            };
            yield {
                type: 'toolcall_delta',
                contentIndex,
                delta: JSON.stringify(block.arguments),
                partial: full,
            };
            yield {
                type: 'toolcall_end',
                contentIndex,
                toolCall: block,
                partial: full,
            };
        }
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        yield { type: 'error', reason: message.stopReason, error: message };
    } else if (message.stopReason !== 'pending') {
        yield { type: 'done', reason: message.stopReason, message };
    }
}
