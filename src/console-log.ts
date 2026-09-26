import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type OutputStream = Pick<NodeJS.WriteStream, 'write'>;
type Channel = 'stdout' | 'stderr';

/** Byte-preserving tee for one CLI invocation, including direct runtime writes. */
export class ConsoleLog {
    readonly directory: string;
    private runDirectory?: string;
    private readonly restorations: (() => void)[] = [];

    constructor(root: string) {
        this.directory = join(root, 'logs', `${Date.now()}-${randomUUID()}`);
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        for (const channel of ['stdout', 'stderr'] as const) {
            appendFileSync(join(this.directory, `${channel}.log`), '', {
                mode: 0o600,
            });
        }
    }

    /** Copy earlier diagnostics once; subsequent writes go to both locations. */
    attachRun(directory: string) {
        if (this.runDirectory === directory) return;
        if (this.runDirectory)
            throw new Error('Console log already belongs to another run');
        for (const channel of ['stdout', 'stderr'] as const) {
            appendFileSync(
                join(directory, `${channel}.log`),
                readFileSync(join(this.directory, `${channel}.log`)),
                { mode: 0o600 },
            );
        }
        this.runDirectory = directory;
    }

    tee(channel: Channel, stream: OutputStream): OutputStream {
        const original = stream.write;
        const write: OutputStream['write'] = (
            chunk: string | Uint8Array,
            encoding?: BufferEncoding | ((error?: Error | null) => void),
            callback?: (error?: Error | null) => void,
        ) => {
            const bytes =
                typeof chunk === 'string'
                    ? Buffer.from(
                          chunk,
                          typeof encoding === 'string' ? encoding : 'utf8',
                      )
                    : chunk;
            appendFileSync(join(this.directory, `${channel}.log`), bytes);
            if (this.runDirectory)
                appendFileSync(
                    join(this.runDirectory, `${channel}.log`),
                    bytes,
                    { mode: 0o600 },
                );
            return typeof encoding === 'function'
                ? original.call(stream, chunk, undefined, encoding)
                : original.call(stream, chunk, encoding, callback);
        };
        // Patch real streams so console.error and dependencies' direct writes
        // are captured too. Injectable test streams need only the local wrapper.
        if (stream === process.stdout || stream === process.stderr) {
            stream.write = write;
            this.restorations.push(() => {
                stream.write = original;
            });
            return stream;
        }
        return { write };
    }

    close() {
        for (const restore of this.restorations.reverse()) restore();
        this.restorations.length = 0;
    }
}
