import { AsyncLocalStorage } from 'node:async_hooks';

export interface EventOwner {
    agent: string;
    taskId?: string;
}

// Async-local attribution keeps concurrent delegations from sharing an owner.
const owners = new AsyncLocalStorage<EventOwner>();

export function currentEventOwner(): EventOwner {
    return owners.getStore() ?? { agent: 'orchestrator' };
}

export function withEventOwner<T>(owner: EventOwner, run: () => T): T {
    return owners.run(owner, run);
}
