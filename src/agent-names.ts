import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

interface AgentName {
    role: string;
    name: string;
}

/** Run-scoped identities, allocated before a task waits for a concurrency slot. */
export class AgentNames {
    private readonly tasks = new Map<string, AgentName>();
    private readonly counters = new Map<string, number>();
    private readonly path?: string;

    constructor(path?: string) {
        this.path = path;
        if (!path) return;
        let source: string;
        try {
            source = readFileSync(path, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        const entries: unknown = JSON.parse(source);
        if (!Array.isArray(entries))
            throw new Error('Invalid agent name registry');
        const names = new Set<string>();
        for (const entry of entries) {
            if (
                !entry ||
                typeof entry.taskId !== 'string' ||
                typeof entry.role !== 'string' ||
                typeof entry.name !== 'string'
            ) {
                throw new Error('Invalid agent name registry entry');
            }
            const number = Number(entry.name.slice(entry.role.length + 1));
            if (
                entry.name !== `${entry.role}-${number}` ||
                !Number.isSafeInteger(number) ||
                number < 1 ||
                names.has(entry.name) ||
                this.tasks.has(entry.taskId)
            ) {
                throw new Error('Invalid or duplicate agent name');
            }
            names.add(entry.name);
            this.tasks.set(entry.taskId, {
                role: entry.role,
                name: entry.name,
            });
            this.counters.set(
                entry.role,
                Math.max(this.counters.get(entry.role) ?? 0, number),
            );
        }
    }

    get(taskId: string, role = 'unknown'): string {
        const existing = this.tasks.get(taskId);
        if (existing) return existing.name;
        const number = (this.counters.get(role) ?? 0) + 1;
        const name = `${role}-${number}`;
        this.counters.set(role, number);
        this.tasks.set(taskId, { role, name });
        if (this.path) {
            const temporary = `${this.path}.${randomUUID()}.tmp`;
            writeFileSync(
                temporary,
                JSON.stringify(
                    [...this.tasks].map(([taskId, value]) => ({
                        taskId,
                        ...value,
                    })),
                ),
                { mode: 0o600 },
            );
            renameSync(temporary, this.path);
        }
        return name;
    }
}
