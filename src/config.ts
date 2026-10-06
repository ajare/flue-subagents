import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ThinkingLevel } from '@earendil-works/pi-ai';

export type ReasoningEffort = 'off' | 'default' | ThinkingLevel;

/** Store credential references only, never API key values. */
export type ModelCredentials =
    | { type: 'local' }
    | { type: 'apiKey'; apiKeyEnv: string };

export const SUBAGENT_ROLES = [
    'explorer',
    'planner',
    'implementer',
    'reviewer',
] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];
export type ModelConfiguration = Pick<
    AgentConfiguration,
    | 'model'
    | 'endpoint'
    | 'contextWindow'
    | 'maxOutputTokens'
    | 'reasoningEffort'
    | 'credentials'
    | 'openRouterProviders'
>;
export type SubagentConfigurations = Partial<
    Record<SubagentRole, Partial<ModelConfiguration>>
>;
const MODEL_KEYS = [
    'model',
    'endpoint',
    'contextWindow',
    'maxOutputTokens',
    'reasoningEffort',
    'credentials',
    'openRouterProviders',
];

export interface AgentConfiguration {
    subagents?: SubagentConfigurations;
    credentials?: ModelCredentials;
    /** OpenRouter provider allowlist; fallback routing is disabled when set. */
    openRouterProviders?: readonly string[];
    model: string;
    endpoint: string;
    contextWindow: number;
    maxOutputTokens: number;
    resultMaxStringLength: number;
    resultMaxCollectionItems: number;
    resultMaxLength: number;
    reasoningEffort: ReasoningEffort;
    readOnlyConcurrency: number;
    implementerConcurrency: number;
    maxDelegations: number;
    maxRepairCycles: number;
    runTimeoutMs: number;
    commandTimeoutMs: number;
    connectivityTimeoutMs: number;
    retentionMs: number;
    workspaceLimitBytes: number;
}

/** Values accepted from CLI adapters and project configuration files. */
export type AgentConfigurationInput = Partial<{
    [Key in keyof Omit<
        AgentConfiguration,
        'subagents' | 'credentials' | 'openRouterProviders'
    >]: AgentConfiguration[Key] | string;
}> & {
    models?: Record<string, Partial<ModelConfiguration>>;
    orchestrator?: string;
    subagents?: Partial<
        Record<SubagentRole, string | Partial<ModelConfiguration>>
    >;
    credentials?: ModelCredentials;
    openRouterProviders?: readonly string[];
};

export const DEFAULT_CONFIGURATION: Readonly<AgentConfiguration> =
    Object.freeze({
        model: 'halogen/qwen-3.8-flash-next',
        endpoint: 'http://localhost:8731/v1',
        contextWindow: 262_144,
        // Output budget is separate from context size and must fit server policy.
        maxOutputTokens: 65_536,
        resultMaxStringLength: 4000,
        resultMaxCollectionItems: 128,
        resultMaxLength: 48000,
        reasoningEffort: 'high',
        readOnlyConcurrency: 4,
        implementerConcurrency: 1,
        maxDelegations: 20,
        maxRepairCycles: 2,
        runTimeoutMs: 30 * 60 * 1_000,
        commandTimeoutMs: 10 * 60 * 1_000,
        connectivityTimeoutMs: 5_000,
        retentionMs: 7 * 24 * 60 * 60 * 1_000,
        workspaceLimitBytes: 10 * 1024 * 1024 * 1024,
    });

export const PROJECT_CONFIGURATION_FILE = 'flue-agent.config.json';

const CONFIGURATION_KEYS = Object.keys(DEFAULT_CONFIGURATION) as Array<
    keyof AgentConfiguration
>;

const ENVIRONMENT_KEYS: Readonly<
    Record<
        keyof Omit<
            AgentConfiguration,
            'subagents' | 'credentials' | 'openRouterProviders'
        >,
        string
    >
> = {
    model: 'FLUE_AGENT_MODEL',
    endpoint: 'FLUE_AGENT_ENDPOINT',
    contextWindow: 'FLUE_AGENT_CONTEXT_WINDOW',
    maxOutputTokens: 'FLUE_AGENT_MAX_OUTPUT_TOKENS',
    resultMaxStringLength: 'FLUE_AGENT_RESULT_MAX_STRING_LENGTH',
    resultMaxCollectionItems: 'FLUE_AGENT_RESULT_MAX_COLLECTION_ITEMS',
    resultMaxLength: 'FLUE_AGENT_RESULT_MAX_LENGTH',
    reasoningEffort: 'FLUE_AGENT_REASONING_EFFORT',
    readOnlyConcurrency: 'FLUE_AGENT_READ_ONLY_CONCURRENCY',
    implementerConcurrency: 'FLUE_AGENT_IMPLEMENTER_CONCURRENCY',
    maxDelegations: 'FLUE_AGENT_MAX_DELEGATIONS',
    maxRepairCycles: 'FLUE_AGENT_MAX_REPAIR_CYCLES',
    runTimeoutMs: 'FLUE_AGENT_RUN_TIMEOUT',
    commandTimeoutMs: 'FLUE_AGENT_COMMAND_TIMEOUT',
    connectivityTimeoutMs: 'FLUE_AGENT_CONNECTIVITY_TIMEOUT',
    retentionMs: 'FLUE_AGENT_RETENTION',
    workspaceLimitBytes: 'FLUE_AGENT_WORKSPACE_LIMIT',
};

/** The non-secret host variables Flue's local sandbox inherits by default. */
export const AGENT_ENVIRONMENT_ALLOWLIST = Object.freeze([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'HOSTNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TERM',
    'TMPDIR',
    'TMP',
    'TEMP',
] as const);

export class ConfigurationError extends Error {
    readonly code = 'invalid_configuration';

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ConfigurationError';
    }
}

export interface ResolveConfigurationOptions {
    /** Highest-precedence values, normally produced by the CLI parser. */
    cli?: AgentConfigurationInput;
    /** Defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    /** Supplying this bypasses project file discovery. */
    project?: AgentConfigurationInput;
    /** Directory containing flue-agent.config.json. Defaults to process.cwd(). */
    cwd?: string;
    /** Override the project configuration file path. */
    configPath?: string;
}

/**
 * Resolve defaults < project file < environment < CLI, then validate the
 * complete result. No filesystem mutation occurs in this phase.
 */
export async function resolveConfiguration(
    options: ResolveConfigurationOptions = {},
): Promise<AgentConfiguration> {
    const project =
        options.project ??
        (await loadProjectConfiguration(
            options.configPath ??
                join(options.cwd ?? process.cwd(), PROJECT_CONFIGURATION_FILE),
            options.configPath !== undefined,
        ));

    return resolveConfigurationSources({
        project,
        env: options.env ?? process.env,
        cli: options.cli,
    });
}

/** Pure source merger, useful to CLI adapters and tests. */
export function resolveConfigurationSources(sources: {
    project?: AgentConfigurationInput;
    env?: NodeJS.ProcessEnv;
    cli?: AgentConfigurationInput;
}): AgentConfiguration {
    const project = normalizeInput(
        sources.project ?? {},
        'project configuration',
    );
    const environment = inputFromEnvironment(sources.env ?? {});
    const cli = normalizeInput(sources.cli ?? {}, 'CLI configuration');
    const merged = {
        ...DEFAULT_CONFIGURATION,
        ...project,
        ...environment,
        ...cli,
    };

    return validateConfiguration(merged);
}

export async function loadProjectConfiguration(
    path: string,
    required = false,
): Promise<AgentConfigurationInput> {
    let source: string;
    try {
        source = await readFile(path, 'utf8');
    } catch (error) {
        if (!required && isNodeError(error) && error.code === 'ENOENT') {
            return {};
        }
        throw new ConfigurationError(
            `Unable to read configuration file ${path}`,
            {
                cause: error,
            },
        );
    }

    try {
        const parsed: unknown = JSON.parse(source);
        if (!isRecord(parsed)) {
            throw new ConfigurationError(
                `Configuration file ${path} must contain an object`,
            );
        }
        return normalizeInput(parsed, `configuration file ${path}`);
    } catch (error) {
        if (error instanceof ConfigurationError) {
            throw error;
        }
        throw new ConfigurationError(
            `Configuration file ${path} is not valid JSON`,
            {
                cause: error,
            },
        );
    }
}

/** Return a stable, serialization-safe configuration report. */
export function configurationForDiagnostics(
    configuration: AgentConfiguration,
): Readonly<AgentConfiguration> {
    return Object.freeze({ ...configuration });
}

/** Snapshot only Flue's restricted, non-secret local-command environment. */
export function restrictedAgentEnvironment(
    hostEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of AGENT_ENVIRONMENT_ALLOWLIST) {
        const value = hostEnvironment[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return environment;
}

function inputFromEnvironment(
    environment: NodeJS.ProcessEnv,
): Partial<AgentConfiguration> {
    const input: Record<string, string> = {};
    for (const key of CONFIGURATION_KEYS) {
        if (
            key === 'subagents' ||
            key === 'credentials' ||
            key === 'openRouterProviders'
        )
            continue;
        const environmentKey = ENVIRONMENT_KEYS[key];
        const value = environment[environmentKey];
        if (value !== undefined) {
            input[key] = value;
        }
    }
    return normalizeInput(input, 'environment');
}

function normalizeInput(
    input: Record<string, unknown> | AgentConfigurationInput,
    source: string,
): Partial<AgentConfiguration> {
    if (!isRecord(input)) {
        throw new ConfigurationError(`${source} must be an object`);
    }

    const expanded = expandModelReferences(input, source);
    const normalized: Record<
        string,
        AgentConfiguration[keyof AgentConfiguration]
    > = {};
    for (const [key, value] of Object.entries(expanded)) {
        if (key === 'openRouterProviders') {
            if (
                !Array.isArray(value) ||
                value.length === 0 ||
                value.some(
                    (item) =>
                        typeof item !== 'string' ||
                        !/^[A-Za-z0-9_-]+$/.test(item),
                )
            )
                throw new ConfigurationError(
                    `${source}.openRouterProviders must be a non-empty list of provider slugs`,
                );
            normalized[key] = Object.freeze([...value]);
            continue;
        }
        if (key === 'credentials') {
            normalized[key] = normalizeCredentials(value, source);
            continue;
        }
        if (key === 'subagents') {
            normalized[key] = normalizeSubagents(value, source);
            continue;
        }
        if (!CONFIGURATION_KEYS.includes(key as keyof AgentConfiguration)) {
            throw new ConfigurationError(`Unknown ${source} option: ${key}`);
        }
        if (value !== undefined) {
            normalized[key] = parseValue(
                key as keyof AgentConfiguration,
                value,
                source,
            );
        }
    }
    return normalized as Partial<AgentConfiguration>;
}

function parseValue(
    key: keyof AgentConfiguration,
    value: unknown,
    source: string,
): AgentConfiguration[keyof AgentConfiguration] {
    switch (key) {
        case 'model':
        case 'endpoint':
            if (typeof value !== 'string' || value.trim() === '') {
                throw invalid(key, source, 'must be a non-empty string');
            }
            return value.trim();
        case 'reasoningEffort': {
            if (
                typeof value !== 'string' ||
                ![
                    'off',
                    'default',
                    'minimal',
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                ].includes(value)
            ) {
                throw invalid(
                    key,
                    source,
                    'must be off, default, minimal, low, medium, high, xhigh, or max',
                );
            }
            return value as ReasoningEffort;
        }
        case 'runTimeoutMs':
        case 'commandTimeoutMs':
        case 'connectivityTimeoutMs':
        case 'retentionMs':
            return parseDuration(value, key, source);
        case 'workspaceLimitBytes':
            return parseSize(value, key, source);
        default:
            return parseInteger(value, key, source);
    }
}

function validateConfiguration(
    configuration: AgentConfiguration,
): AgentConfiguration {
    const separator = configuration.model.indexOf('/');
    if (separator < 1 || separator === configuration.model.length - 1) {
        throw new ConfigurationError(
            'model must use the provider/model form (for example halogen/qwen-3.8-flash-next)',
        );
    }

    let endpoint: URL;
    try {
        endpoint = new URL(configuration.endpoint);
    } catch {
        throw new ConfigurationError(
            'endpoint must be an absolute HTTP(S) URL',
        );
    }
    if (
        !['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
    ) {
        throw new ConfigurationError(
            'endpoint must be an absolute HTTP(S) URL without credentials, query parameters, or fragments',
        );
    }

    if (configuration.maxOutputTokens > configuration.contextWindow) {
        throw new ConfigurationError(
            'maxOutputTokens cannot exceed contextWindow',
        );
    }
    if (configuration.implementerConcurrency !== 1) {
        throw new ConfigurationError(
            'implementerConcurrency must be 1 because repository mutation is serialized',
        );
    }
    if (configuration.commandTimeoutMs > configuration.runTimeoutMs) {
        throw new ConfigurationError(
            'commandTimeoutMs cannot exceed runTimeoutMs',
        );
    }

    if (configuration.subagents) {
        for (const settings of Object.values(configuration.subagents)) {
            validateConfiguration({
                ...configuration,
                ...settings,
                subagents: undefined,
            });
        }
    }
    return Object.freeze({ ...configuration });
}

function normalizeCredentials(
    value: unknown,
    source: string,
): ModelCredentials {
    if (!isRecord(value))
        throw new ConfigurationError(`${source}.credentials must be an object`);
    if (value.type === 'local' && Object.keys(value).length === 1)
        return Object.freeze({ type: 'local' });
    if (
        value.type === 'apiKey' &&
        Object.keys(value).length === 2 &&
        typeof value.apiKeyEnv === 'string' &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv)
    ) {
        if (
            (AGENT_ENVIRONMENT_ALLOWLIST as readonly string[]).includes(
                value.apiKeyEnv,
            )
        )
            throw new ConfigurationError(
                'Credential environment variables must not be sandbox-allowlisted',
            );
        return Object.freeze({ type: 'apiKey', apiKeyEnv: value.apiKeyEnv });
    }
    throw new ConfigurationError(
        `${source}.credentials must be { type: "local" } or { type: "apiKey", apiKeyEnv: "ENV_VARIABLE" }; literal API keys are not supported`,
    );
}

function expandModelReferences(
    input: Record<string, unknown>,
    source: string,
): Record<string, unknown> {
    const definitions = new Map<string, Partial<ModelConfiguration>>();
    if ('models' in input) {
        if (!isRecord(input.models))
            throw new ConfigurationError(`${source}.models must be an object`);
        for (const [name, settings] of Object.entries(input.models)) {
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))
                throw new ConfigurationError(
                    `Invalid model definition name: ${name}`,
                );
            const definition = normalizeModelSettings(
                settings,
                `${source}.models.${name}`,
            );
            validateConfiguration({ ...DEFAULT_CONFIGURATION, ...definition });
            definitions.set(name, definition);
        }
    }
    const resolve = (
        reference: unknown,
        path: string,
    ): Partial<ModelConfiguration> => {
        if (typeof reference !== 'string' || reference.length === 0)
            throw new ConfigurationError(
                `${path} must reference a model definition by name`,
            );
        const definition = definitions.get(reference);
        if (!definition)
            throw new ConfigurationError(
                `Unknown model definition ${reference} referenced by ${path}`,
            );
        return { ...definition };
    };
    const expanded = { ...input };
    delete expanded.models;
    delete expanded.orchestrator;
    if ('orchestrator' in input) {
        if (MODEL_KEYS.some((key) => key in input))
            throw new ConfigurationError(
                'Named orchestrator configuration cannot be combined with inline model settings',
            );
        Object.assign(
            expanded,
            resolve(input.orchestrator, `${source}.orchestrator`),
        );
    }
    if (isRecord(input.subagents)) {
        expanded.subagents = Object.fromEntries(
            Object.entries(input.subagents).map(([role, settings]) => [
                role,
                typeof settings === 'string'
                    ? resolve(settings, `${source}.subagents.${role}`)
                    : settings,
            ]),
        );
    }
    return expanded;
}

function normalizeModelSettings(
    value: unknown,
    source: string,
): Partial<ModelConfiguration> {
    if (!isRecord(value))
        throw new ConfigurationError(`${source} must be an object`);
    for (const key of Object.keys(value)) {
        if (!MODEL_KEYS.includes(key))
            throw new ConfigurationError(`Unknown ${source} option: ${key}`);
    }
    return Object.freeze(normalizeInput(value, source));
}

function normalizeSubagents(
    value: unknown,
    source: string,
): SubagentConfigurations {
    if (!isRecord(value))
        throw new ConfigurationError(`${source}.subagents must be an object`);
    const result: SubagentConfigurations = {};
    for (const [role, settings] of Object.entries(value)) {
        if (!SUBAGENT_ROLES.includes(role as SubagentRole))
            throw new ConfigurationError(`Unknown subagent role: ${role}`);
        result[role as SubagentRole] = normalizeModelSettings(
            settings,
            `${source}.subagents.${role}`,
        );
    }
    return Object.freeze(result);
}

/** Give each configured role a distinct provider namespace, even for identical model IDs. */
export function subagentConfiguration(
    configuration: AgentConfiguration,
    role: SubagentRole,
): AgentConfiguration {
    const settings = configuration.subagents?.[role];
    if (!settings) return configuration;
    const resolved = { ...configuration, ...settings, subagents: undefined };
    const modelId = resolved.model.slice(resolved.model.indexOf('/') + 1);
    return { ...resolved, model: `flue-${role}/${modelId}` };
}

function parseInteger(
    value: unknown,
    key: keyof AgentConfiguration,
    source: string,
): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw invalid(key, source, 'must be a positive integer');
    }
    return number;
}

function parseDuration(
    value: unknown,
    key: keyof AgentConfiguration,
    source: string,
): number {
    if (typeof value === 'number') {
        if (key === 'retentionMs' && value === 0) return 0;
        return parseInteger(value, key, source);
    }
    if (typeof value !== 'string') {
        throw invalid(
            key,
            source,
            'must be a duration such as 500ms, 10m, or 2h',
        );
    }
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/iu.exec(value.trim());
    if (!match) {
        throw invalid(
            key,
            source,
            'must be a duration such as 500ms, 10m, or 2h',
        );
    }
    const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    const number =
        Number(match[1]) *
        factors[(match[2]?.toLowerCase() ?? 'ms') as keyof typeof factors];
    if (
        !Number.isSafeInteger(number) ||
        number < 0 ||
        (number === 0 && key !== 'retentionMs')
    ) {
        throw invalid(
            key,
            source,
            key === 'retentionMs' ? 'must not be negative' : 'must be positive',
        );
    }
    return number;
}

function parseSize(
    value: unknown,
    key: keyof AgentConfiguration,
    source: string,
): number {
    if (typeof value === 'number') return parseInteger(value, key, source);
    if (typeof value !== 'string') {
        throw invalid(key, source, 'must be a byte size such as 500mb or 10gb');
    }
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|kib|mib|gib|tib)?$/iu.exec(
        value.trim(),
    );
    if (!match)
        throw invalid(key, source, 'must be a byte size such as 500mb or 10gb');
    const suffix = (match[2]?.toLowerCase() ?? 'b') as keyof typeof factors;
    const factors = {
        b: 1,
        kb: 1_000,
        mb: 1_000_000,
        gb: 1_000_000_000,
        tb: 1_000_000_000_000,
        kib: 1024,
        mib: 1024 ** 2,
        gib: 1024 ** 3,
        tib: 1024 ** 4,
    };
    const number = Number(match[1]) * factors[suffix];
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw invalid(
            key,
            source,
            'must resolve to a positive whole number of bytes',
        );
    }
    return number;
}

function invalid(
    key: keyof AgentConfiguration,
    source: string,
    detail: string,
) {
    return new ConfigurationError(`Invalid ${key} in ${source}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
