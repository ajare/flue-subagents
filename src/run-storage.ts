import { randomUUID } from 'node:crypto';
import { currentEventOwner } from './event-owner.ts';
import {
    mkdir,
    lstat,
    open,
    readFile,
    realpath,
    rename,
    rm,
    stat,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { assertReviewApproval } from './review-gating.ts';
import {
    type AgentConfiguration,
    DEFAULT_CONFIGURATION,
    resolveConfigurationSources,
} from './config.ts';
import {
    freezeLedger,
    replayLedger,
    type LedgerAction,
    type LedgerEvent,
} from './delegation-ledger.ts';

export const RUN_RECORD_VERSION = 1;
export const RUN_RECORD_FILE = 'run.json';

export type RunStatus =
    | 'running'
    | 'completed'
    | 'needs_input'
    | 'blocked'
    | 'failed'
    | 'interrupted';

export interface RepositoryIdentity {
    /** Canonical absolute path at the time the run was created. */
    path: string;
    /** Filesystem identity used to detect a path replaced by another directory. */
    device: number;
    inode: number;
}

export interface RunTimestamps {
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
}

export interface RunLocations {
    workspace: string | null;
    auditLog: string;
}

/** Durable state needed to inspect and later continue a run. */
export interface RunRecord {
    schemaVersion: typeof RUN_RECORD_VERSION;
    id: string;
    revision: number;
    status: RunStatus;
    configuration: AgentConfiguration;
    repository: RepositoryIdentity;
    timestamps: RunTimestamps;
    conversationId: string;
    locations: RunLocations;
    ledger: LedgerEvent[];
}

export interface CreateRunInput {
    repository: string;
    configuration: AgentConfiguration;
    conversationId?: string;
    workspace?: string | null;
    auditLog?: string;
}

export interface UpdateRunInput {
    ledgerAction?: LedgerAction;
    status?: RunStatus;
    conversationId?: string;
    workspace?: string | null;
    auditLog?: string;
}

export interface RunStoreOptions {
    root?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
    generateId?: () => string;
    onUpdate?: (record: RunRecord) => void;
}

export class RunStorageError extends Error {
    readonly code:
        | 'invalid_run_record'
        | 'invalid_status_transition'
        | 'run_not_found'
        | 'unsafe_storage_location';

    constructor(
        code: RunStorageError['code'],
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'RunStorageError';
        this.code = code;
    }
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
    'completed',
    'blocked',
    'failed',
]);

const TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
    running: new Set([
        'completed',
        'needs_input',
        'blocked',
        'failed',
        'interrupted',
    ]),
    needs_input: new Set(['running', 'blocked', 'failed', 'interrupted']),
    interrupted: new Set(['running', 'blocked', 'failed']),
    // Post-publication commit hooks can fail or mutate output after review.
    // That late failure must be durably represented rather than reported as success.
    completed: new Set(['blocked']),
    blocked: new Set(),
    failed: new Set(),
};

/** Resolve the platform user-data location without touching the filesystem. */
export function userDataDirectory(
    env: NodeJS.ProcessEnv = process.env,
    operatingSystem = platform(),
): string {
    const override = env.FLUE_AGENT_DATA_DIR;
    if (override?.trim()) return resolve(override);

    if (operatingSystem === 'win32') {
        return join(
            env.LOCALAPPDATA ??
                env.APPDATA ??
                join(env.USERPROFILE ?? homedir(), 'AppData', 'Local'),
            'flue-agent',
        );
    }
    if (operatingSystem === 'darwin') {
        return join(
            env.HOME ?? homedir(),
            'Library',
            'Application Support',
            'flue-agent',
        );
    }
    return join(
        env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), '.local', 'share'),
        'flue-agent',
    );
}

/** Filesystem-backed run records. A record is one atomic JSON document. */
export class RunStore {
    readonly root: string;
    readonly runsDirectory: string;
    private readonly now: () => Date;
    private readonly generateId: () => string;
    private readonly onUpdate?: (record: RunRecord) => void;
    private readonly updates = new Map<string, Promise<unknown>>();

    constructor(options: RunStoreOptions = {}) {
        this.root = resolve(options.root ?? userDataDirectory(options.env));
        this.runsDirectory = join(this.root, 'runs');
        this.now = options.now ?? (() => new Date());
        this.generateId = options.generateId ?? randomUUID;
        this.onUpdate = options.onUpdate;
    }

    async create(input: CreateRunInput): Promise<RunRecord> {
        const repositoryPath = await realpath(input.repository);
        const repositoryStat = await stat(repositoryPath);
        if (!repositoryStat.isDirectory()) {
            throw new RunStorageError(
                'invalid_run_record',
                `Repository is not a directory: ${input.repository}`,
            );
        }
        assertStorageOutsideRepository(this.root, repositoryPath);
        assertStorageOutsideRepository(
            await canonicalDestination(this.root),
            repositoryPath,
        );

        const id = this.generateId();
        assertRunId(id);
        const runDirectory = this.runDirectory(id);
        const createdAt = this.now().toISOString();
        const record: RunRecord = {
            schemaVersion: RUN_RECORD_VERSION,
            id,
            revision: 0,
            ledger: [],
            status: 'running',
            configuration: cloneConfiguration(input.configuration),
            repository: {
                path: repositoryPath,
                device: repositoryStat.dev,
                inode: repositoryStat.ino,
            },
            timestamps: { createdAt, updatedAt: createdAt, completedAt: null },
            conversationId: input.conversationId ?? id,
            locations: {
                workspace: input.workspace ?? null,
                auditLog: input.auditLog ?? join(runDirectory, 'audit.ndjson'),
            },
        };
        validateRunRecord(record, id);

        try {
            await mkdir(this.runsDirectory, { recursive: true, mode: 0o700 });
            await mkdir(runDirectory, { recursive: false, mode: 0o700 });
        } catch (error) {
            throw new RunStorageError(
                'invalid_run_record',
                `Unable to create run ${id}`,
                { cause: error },
            );
        }
        try {
            await writeAtomic(this.recordPath(id), record);
        } catch (error) {
            await rm(runDirectory, { recursive: true, force: true });
            throw error;
        }
        return freezeRecord(record);
    }

    async read(id: string): Promise<RunRecord> {
        assertRunId(id);
        let source: string;
        try {
            if (!(await lstat(this.runDirectory(id))).isDirectory()) {
                throw new Error('Run directory must not be a symbolic link');
            }
            source = await readFile(this.recordPath(id), 'utf8');
        } catch (error) {
            if (isNodeError(error) && error.code === 'ENOENT') {
                throw new RunStorageError(
                    'run_not_found',
                    `Run not found: ${id}`,
                );
            }
            throw new RunStorageError(
                'invalid_run_record',
                `Unable to read run ${id}`,
                { cause: error },
            );
        }

        try {
            const value: unknown = JSON.parse(source);
            return freezeRecord(validateRunRecord(value, id));
        } catch (error) {
            if (error instanceof RunStorageError) throw error;
            throw new RunStorageError(
                'invalid_run_record',
                `Run record ${id} is not valid JSON`,
                { cause: error },
            );
        }
    }

    /** Serialize updates in this process and replace the complete record atomically. */
    async update(id: string, update: UpdateRunInput): Promise<RunRecord> {
        const owner = currentEventOwner();
        assertRunId(id);
        update = structuredClone(update);
        const previous = this.updates.get(id) ?? Promise.resolve();
        const operation = previous
            .catch(() => {})
            .then(async () => {
                const current = await this.read(id);
                const status = update.status ?? current.status;
                assertTransition(current.status, status);
                const updatedAt = this.now().toISOString();
                const next: RunRecord = {
                    ...current,
                    revision: current.revision + 1,
                    ledger: update.ledgerAction
                        ? [
                              ...current.ledger,
                              {
                                  sequence: current.ledger.length + 1,
                                  at: Date.parse(updatedAt),
                                  ...owner,
                                  action: update.ledgerAction,
                              },
                          ]
                        : [...current.ledger],
                    status,
                    configuration: cloneConfiguration(current.configuration),
                    repository: { ...current.repository },
                    timestamps: {
                        ...current.timestamps,
                        updatedAt,
                        completedAt: TERMINAL_STATUSES.has(status)
                            ? (current.timestamps.completedAt ?? updatedAt)
                            : null,
                    },
                    conversationId:
                        update.conversationId ?? current.conversationId,
                    locations: {
                        workspace:
                            update.workspace === undefined
                                ? current.locations.workspace
                                : update.workspace,
                        auditLog: update.auditLog ?? current.locations.auditLog,
                    },
                };
                if (status === 'completed') assertReviewApproval(next.ledger);
                validateRunRecord(next, id);
                await writeAtomic(this.recordPath(id), next);
                const frozen = freezeRecord(next);
                this.onUpdate?.(frozen);
                return frozen;
            });
        this.updates.set(id, operation);
        try {
            return await operation;
        } finally {
            if (this.updates.get(id) === operation) this.updates.delete(id);
        }
    }

    runDirectory(id: string): string {
        assertRunId(id);
        return join(this.runsDirectory, id);
    }

    recordPath(id: string): string {
        return join(this.runDirectory(id), RUN_RECORD_FILE);
    }
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
    if (from !== to && !TRANSITIONS[from].has(to)) {
        throw new RunStorageError(
            'invalid_status_transition',
            `Invalid run status transition: ${from} -> ${to}`,
        );
    }
}

function validateRunRecord(value: unknown, expectedId?: string): RunRecord {
    if (!isRecord(value)) throw invalidRecord('must contain an object');
    // Version 1 records created before the ledger was introduced have no events.
    if (!('ledger' in value)) value.ledger = [];
    assertKeys(value, [
        'ledger',
        'schemaVersion',
        'id',
        'revision',
        'status',
        'configuration',
        'repository',
        'timestamps',
        'conversationId',
        'locations',
    ]);
    const id = requiredString(value.id, 'id');
    assertRunId(id);
    if (expectedId !== undefined && id !== expectedId) {
        throw invalidRecord('id does not match its storage location');
    }
    if (value.schemaVersion !== RUN_RECORD_VERSION) {
        throw invalidRecord(
            `unsupported schemaVersion: ${String(value.schemaVersion)}`,
        );
    }
    if (
        !Number.isSafeInteger(value.revision) ||
        (value.revision as number) < 0
    ) {
        throw invalidRecord('revision must be a non-negative integer');
    }
    if (!isRunStatus(value.status)) throw invalidRecord('status is invalid');
    validateConfiguration(value.configuration);
    validateRepository(value.repository);
    validateTimestamps(value.timestamps, value.status);
    requiredString(value.conversationId, 'conversationId');
    validateLocations(value.locations);
    try {
        replayLedger(value.ledger);
    } catch (cause) {
        throw new RunStorageError(
            'invalid_run_record',
            'Invalid delegation ledger',
            { cause },
        );
    }
    return value as unknown as RunRecord;
}

function validateConfiguration(
    value: unknown,
): asserts value is AgentConfiguration {
    if (!isRecord(value))
        throw invalidRecord('configuration must be an object');
    const stringKeys = ['model', 'endpoint', 'reasoningEffort'];
    const numberKeys = [
        'contextWindow',
        'maxOutputTokens',
        'readOnlyConcurrency',
        'implementerConcurrency',
        'maxDelegations',
        'maxRepairCycles',
        'runTimeoutMs',
        'commandTimeoutMs',
        'connectivityTimeoutMs',
        'retentionMs',
        'workspaceLimitBytes',
    ];
    const presentationKeys = [
        'resultMaxStringLength',
        'resultMaxCollectionItems',
        'resultMaxLength',
    ] as const;
    // Version-1 snapshots may predate these fields. Normalize before checking
    // required keys so readers (including startup cleanup) accept legacy runs.
    for (const key of presentationKeys) {
        if (!(key in value)) value[key] = DEFAULT_CONFIGURATION[key];
    }
    assertKeys(value, [
        ...stringKeys,
        ...numberKeys,
        ...presentationKeys,
        ...('subagents' in value ? ['subagents'] : []),
        ...('credentials' in value ? ['credentials'] : []),
        ...('openRouterProviders' in value ? ['openRouterProviders'] : []),
    ]);
    if (
        value.subagents !== undefined ||
        value.credentials !== undefined ||
        value.openRouterProviders !== undefined
    ) {
        try {
            resolveConfigurationSources({
                project: value as unknown as AgentConfiguration,
            });
        } catch (cause) {
            throw new RunStorageError(
                'invalid_run_record',
                'Invalid model configuration',
                { cause },
            );
        }
    }
    for (const key of presentationKeys) {
        if (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0)
            throw invalidRecord(
                `configuration.${key} must be a positive integer`,
            );
    }
    for (const key of stringKeys)
        requiredString(value[key], `configuration.${key}`);
    for (const key of numberKeys) {
        if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
            throw invalidRecord(
                `configuration.${key} must be a non-negative integer`,
            );
        }
    }
}

function validateRepository(
    value: unknown,
): asserts value is RepositoryIdentity {
    if (!isRecord(value)) throw invalidRecord('repository must be an object');
    assertKeys(value, ['path', 'device', 'inode']);
    const path = requiredString(value.path, 'repository.path');
    if (!isAbsolute(path))
        throw invalidRecord('repository.path must be absolute');
    for (const key of ['device', 'inode']) {
        if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
            throw invalidRecord(
                `repository.${key} must be a non-negative integer`,
            );
        }
    }
}

function validateTimestamps(
    value: unknown,
    status: RunStatus,
): asserts value is RunTimestamps {
    if (!isRecord(value)) throw invalidRecord('timestamps must be an object');
    assertKeys(value, ['createdAt', 'updatedAt', 'completedAt']);
    const createdAt = parseTimestamp(value.createdAt, 'timestamps.createdAt');
    const updatedAt = parseTimestamp(value.updatedAt, 'timestamps.updatedAt');
    if (updatedAt < createdAt)
        throw invalidRecord('updatedAt precedes createdAt');
    if (TERMINAL_STATUSES.has(status)) {
        const completedAt = parseTimestamp(
            value.completedAt,
            'timestamps.completedAt',
        );
        if (completedAt < createdAt)
            throw invalidRecord('completedAt precedes createdAt');
    } else if (value.completedAt !== null) {
        throw invalidRecord('completedAt must be null for a non-terminal run');
    }
}

function validateLocations(value: unknown): asserts value is RunLocations {
    if (!isRecord(value)) throw invalidRecord('locations must be an object');
    assertKeys(value, ['workspace', 'auditLog']);
    if (value.workspace !== null) {
        const workspace = requiredString(
            value.workspace,
            'locations.workspace',
        );
        if (!isAbsolute(workspace))
            throw invalidRecord('locations.workspace must be absolute');
    }
    const auditLog = requiredString(value.auditLog, 'locations.auditLog');
    if (!isAbsolute(auditLog))
        throw invalidRecord('locations.auditLog must be absolute');
}

async function writeAtomic(path: string, value: RunRecord): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporary, path);
        await syncDirectory(dirname(path));
    } catch (error) {
        await file?.close().catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
        throw new RunStorageError(
            'invalid_run_record',
            `Unable to persist run record ${path}`,
            { cause: error },
        );
    }
}

async function canonicalDestination(path: string): Promise<string> {
    let ancestor = path;
    for (;;) {
        try {
            const canonicalAncestor = await realpath(ancestor);
            return resolve(canonicalAncestor, relative(ancestor, path));
        } catch (error) {
            if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
            const parent = dirname(ancestor);
            if (parent === ancestor) throw error;
            ancestor = parent;
        }
    }
}

async function syncDirectory(path: string): Promise<void> {
    try {
        const directory = await open(path, 'r');
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } catch (error) {
        // Some filesystems do not permit opening or synchronizing directories.
        // The file itself is still synced before the atomic rename.
        if (
            !isNodeError(error) ||
            !['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EISDIR'].includes(
                error.code ?? '',
            )
        ) {
            throw error;
        }
    }
}

function assertStorageOutsideRepository(
    root: string,
    repository: string,
): void {
    const difference = relative(repository, root);
    if (
        difference === '' ||
        (!difference.startsWith('..') && !isAbsolute(difference))
    ) {
        throw new RunStorageError(
            'unsafe_storage_location',
            `Run storage must be outside the target repository: ${root}`,
        );
    }
}

function assertRunId(id: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id)) {
        throw invalidRecord(`invalid run id: ${id}`);
    }
}

function assertKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
): void {
    const expectedKeys = new Set(expected);
    for (const key of Object.keys(value)) {
        if (!expectedKeys.has(key))
            throw invalidRecord(`unknown field: ${key}`);
    }
    for (const key of expected) {
        if (!(key in value)) throw invalidRecord(`missing field: ${key}`);
    }
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw invalidRecord(`${field} must be a non-empty string`);
    }
    return value;
}

function parseTimestamp(value: unknown, field: string): number {
    const source = requiredString(value, field);
    const timestamp = Date.parse(source);
    if (!Number.isFinite(timestamp)) throw invalidRecord(`${field} is invalid`);
    return timestamp;
}

function isRunStatus(value: unknown): value is RunStatus {
    return (
        typeof value === 'string' &&
        [
            'running',
            'completed',
            'needs_input',
            'blocked',
            'failed',
            'interrupted',
        ].includes(value)
    );
}

function cloneConfiguration(
    configuration: AgentConfiguration,
): AgentConfiguration {
    return { ...configuration };
}

function freezeRecord(record: RunRecord): RunRecord {
    freezeLedger(record.ledger);
    Object.freeze(record.configuration);
    Object.freeze(record.repository);
    Object.freeze(record.timestamps);
    Object.freeze(record.locations);
    return Object.freeze(record);
}

function invalidRecord(message: string): RunStorageError {
    return new RunStorageError(
        'invalid_run_record',
        `Invalid run record: ${message}`,
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
