import { AsyncLocalStorage } from 'node:async_hooks';
import { createParser } from 'eventsource-parser';

export interface ProviderStats {
    timings?: Record<string, unknown>;
    usage?: Record<string, unknown>;
}

const active = new AsyncLocalStorage<ProviderStats>();
const turns = new Map<string, { instanceId: string; stats: ProviderStats }>();

/** Keep raw provider statistics scoped to the actual model turn, not the task. */
export async function withProviderStats<T>(
    turnId: string,
    instanceId: string,
    run: () => Promise<T>,
): Promise<T> {
    // Flue also intercepts each iterator.next() for the same model turn.
    const stats: ProviderStats = turns.get(turnId)?.stats ?? {};
    turns.set(turnId, { instanceId, stats });
    // The interceptor returns a stream before it has been consumed. Keep the
    // collector until the terminal turn observation (or run disposal).
    return active.run(stats, run);
}

export function takeProviderStats(turnId: string): ProviderStats {
    const entry = turns.get(turnId);
    turns.delete(turnId);
    return structuredClone(entry?.stats ?? {});
}

export function clearProviderStats(instanceId: string): void {
    for (const [id, entry] of turns) {
        if (entry.instanceId === instanceId) turns.delete(id);
    }
}

/** Tap the response in-line: no tee, background reader, or buffered model output. */
export function statsFetch(
    fetchImplementation: typeof fetch = globalThis.fetch,
): typeof fetch {
    const stats = active.getStore();
    return async (input, init) => {
        const response = await fetchImplementation(input, init);
        if (!stats || !response.ok || !response.body) return response;
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) return response;
        const decoder = new TextDecoder();
        let disabled = false;
        const parser = createParser({
            maxBufferSize: 1024 * 1024,
            onError(error) {
                // Observability must not break an otherwise usable model stream.
                if (error.type === 'max-buffer-size-exceeded') disabled = true;
            },
            onEvent({ data }) {
                if (data === '[DONE]') return;
                let chunk: unknown;
                try {
                    chunk = JSON.parse(data);
                } catch {
                    return;
                }
                if (!isObject(chunk)) return;
                // Only these metadata objects are retained; never choices/content.
                if (isObject(chunk.timings))
                    stats.timings = { ...stats.timings, ...chunk.timings };
                if (isObject(chunk.usage))
                    stats.usage = { ...stats.usage, ...chunk.usage };
            },
        });
        const body = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    if (!disabled)
                        parser.feed(decoder.decode(chunk, { stream: true }));
                    controller.enqueue(chunk);
                },
                flush() {
                    if (!disabled) parser.feed(decoder.decode());
                },
            }),
        );
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
