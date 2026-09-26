import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ThinkingLevel } from '@earendil-works/pi-ai';

export type ReasoningEffort = 'off' | ThinkingLevel;

export interface AgentConfiguration {
    model: string;
    endpoint: string;
    contextWindow: number;
    maxOutputTokens: number;
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
    [Key in keyof AgentConfiguration]: AgentConfiguration[Key] | string;
}>;

export const DEFAULT_CONFIGURATION: Readonly<AgentConfiguration> =
    Object.freeze({
        model: 'halogen/qwen-3.8-flash-next',
        endpoint: 'http://localhost:8731/v1',
        contextWindow: 262_144,
        // Output budget is separate from context size and must fit server policy.
        maxOutputTokens: 65_536,
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

const ENVIRONMENT_KEYS: Readonly<Record<keyof AgentConfiguration, string>> = {
    model: 'FLUE_AGENT_MODEL',
    endpoint: 'FLUE_AGENT_ENDPOINT',
    contextWindow: 'FLUE_AGENT_CONTEXT_WINDOW',
    maxOutputTokens: 'FLUE_AGENT_MAX_OUTPUT_TOKENS',
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
): Promise<AgentConfigurationInput> {
    let source: string;
    try {
        source = await readFile(path, 'utf8');
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
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

    const normalized: Record<
        string,
        AgentConfiguration[keyof AgentConfiguration]
    > = {};
    for (const [key, value] of Object.entries(input)) {
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
                    'must be off, minimal, low, medium, high, xhigh, or max',
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

    return Object.freeze({ ...configuration });
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
