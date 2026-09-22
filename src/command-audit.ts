import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CommandAuditRecord {
    timestamp: string;
    command: string;
    cwd: string;
    durationMs: number;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outcome: 'completed' | 'cancelled' | 'failed';
}

export interface CommandAuditSink {
    record(record: CommandAuditRecord): Promise<void>;
}

/** Append-only NDJSON command log. Writes are serialized to keep records intact. */
export class FileCommandAuditLog implements CommandAuditSink {
    readonly path: string;
    private tail: Promise<void> = Promise.resolve();

    constructor(path: string) {
        this.path = path;
    }

    record(record: CommandAuditRecord): Promise<void> {
        const line = `${JSON.stringify(record)}\n`;
        const write = this.tail.then(async () => {
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            await appendFile(this.path, line, {
                encoding: 'utf8',
                mode: 0o600,
            });
        });
        this.tail = write.catch(() => {});
        return write;
    }
}
