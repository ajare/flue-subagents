#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { createOrchestrator } from './agents/orchestrator.ts';
import { FileCommandAuditLog } from './command-audit.ts';
import {
    CommitManager,
    commitRequestFromPrompt,
    type CommitRequest,
} from './commit-handling.ts';
import {
    type AgentConfiguration,
    resolveConfiguration,
    restrictedAgentEnvironment,
} from './config.ts';
import {
    type GitPreflightResult,
    preflightGitRepository,
} from './git-preflight.ts';
import {
    checkModelConnectivity,
    createModelProvider,
} from './model-provider.ts';
import { blockOnLimit, OrchestrationLimits } from './orchestration-limits.ts';
import {
    assertOrchestrationIntegrity,
    formatOrchestratorResult,
    installOrchestrationPolicy,
    validateOrchestratorResult,
} from './orchestrator-policy.ts';
import { PatchManager } from './patch-publication.ts';
import { completionEligibility, replayLedger } from './delegation-ledger.ts';
import { isMutationRun } from './review-gating.ts';
import { RunStore } from './run-storage.ts';
import { workspaceLocal } from './sandboxes/workspace-local.ts';
import { WorkspaceManager } from './workspaces.ts';

export interface ExecutionRequest {
    prompt: string;
    repository: string;
    configuration: AgentConfiguration;
    repositoryState: GitPreflightResult;
    /** Captured from the original user input, never inferred from agent output. */
    commitRequest?: CommitRequest;
}

export type ExecuteRequest = (
    request: ExecutionRequest,
) => Promise<string | undefined>;

export interface CliDependencies {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: AsyncIterable<unknown>;
    stdout?: Pick<NodeJS.WriteStream, 'write'>;
    stderr?: Pick<NodeJS.WriteStream, 'write'>;
    version?: string;
    execute?: ExecuteRequest;
}

export class CliUsageError extends Error {
    readonly code = 'invalid_arguments';

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'CliUsageError';
    }
}

interface ParsedArguments {
    action: 'execute' | 'help' | 'version';
    repo: string;
    prompt?: string;
    allowDirty: boolean;
    commit: boolean;
}

export const HELP = `Usage:
  flue-agent [--repo <path>] [--allow-dirty] [--commit] "<prompt>"
  printf '%s' "<prompt>" | flue-agent [--repo <path>] [--allow-dirty] [--commit]

Submit one engineering objective for autonomous execution.

Options:
  --repo <path>  Repository to operate on (default: current directory)
  --allow-dirty  Permit and fingerprint staged, unstaged, and untracked changes
  --commit       Commit the approved published patch (hooks run normally)
  -h, --help     Show this help
  -v, --version  Show the package version

Security: flue-agent is for trusted-local operation only. Use it only with
trusted prompts and trusted repositories; the agent can inspect and modify code.
`;

/** Parse the deliberately small one-shot command surface. */
export function parseCliArguments(
    argv: readonly string[],
    cwd = process.cwd(),
): ParsedArguments {
    let repo = cwd;
    let prompt: string | undefined;
    let allowDirty = false;
    let commit = false;
    let positionalOnly = false;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index] as string;
        if (!positionalOnly && argument === '--') {
            positionalOnly = true;
            continue;
        }
        if (!positionalOnly && (argument === '--help' || argument === '-h')) {
            return { action: 'help', repo, allowDirty, commit };
        }
        if (
            !positionalOnly &&
            (argument === '--version' || argument === '-v')
        ) {
            return { action: 'version', repo, allowDirty, commit };
        }
        if (!positionalOnly && argument === '--allow-dirty') {
            allowDirty = true;
            continue;
        }
        if (!positionalOnly && argument === '--commit') {
            commit = true;
            continue;
        }
        if (!positionalOnly && argument === '--repo') {
            const value = argv[index + 1];
            if (value === undefined || value === '') {
                throw new CliUsageError('--repo requires a path');
            }
            repo = resolve(cwd, value);
            index += 1;
            continue;
        }
        if (!positionalOnly && argument.startsWith('--repo=')) {
            const value = argument.slice('--repo='.length);
            if (value === '') throw new CliUsageError('--repo requires a path');
            repo = resolve(cwd, value);
            continue;
        }
        if (!positionalOnly && argument.startsWith('-')) {
            throw new CliUsageError(`Unknown option: ${argument}`);
        }
        if (prompt !== undefined) {
            throw new CliUsageError(
                'Expected one prompt argument; quote prompts containing spaces',
            );
        }
        prompt = argument;
    }

    return { action: 'execute', repo, prompt, allowDirty, commit };
}

/**
 * Convert parsed user input into the canonical request consumed by the runner.
 * Prompt edge whitespace is normalized so quoted and piped forms are equal.
 */
export async function createExecutionRequest(options: {
    repo: string;
    prompt: string;
    env?: NodeJS.ProcessEnv;
    allowDirty?: boolean;
    commit?: boolean;
}): Promise<ExecutionRequest> {
    const prompt = options.prompt.trim();
    if (prompt === '') {
        throw new CliUsageError('An engineering prompt is required');
    }

    let repository: string;
    try {
        repository = await realpath(options.repo);
        if (!(await stat(repository)).isDirectory()) {
            throw new CliUsageError(
                `Repository path is not a directory: ${options.repo}`,
            );
        }
    } catch (error) {
        if (error instanceof CliUsageError) throw error;
        throw new CliUsageError(
            `Cannot resolve repository path ${options.repo}: ${errorMessage(error)}`,
            { cause: error },
        );
    }

    const repositoryState = await preflightGitRepository(repository, {
        allowDirty: options.allowDirty,
        env: options.env,
    });
    repository = repositoryState.repository.root;
    const configuration = await resolveConfiguration({
        cwd: repository,
        env: options.env,
    });
    return {
        prompt,
        repository,
        configuration,
        repositoryState,
        commitRequest: commitRequestFromPrompt(prompt, options.commit),
    };
}

/** Run the CLI with injectable streams and execution for deterministic tests. */
export async function runCli(
    argv: readonly string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    const stdout = dependencies.stdout ?? process.stdout;
    const stderr = dependencies.stderr ?? process.stderr;

    try {
        const parsed = parseCliArguments(
            argv,
            dependencies.cwd ?? process.cwd(),
        );
        if (parsed.action === 'help') {
            stdout.write(HELP);
            return 0;
        }
        if (parsed.action === 'version') {
            stdout.write(
                `${dependencies.version ?? (await packageVersion())}\n`,
            );
            return 0;
        }

        const input =
            parsed.prompt ??
            (await readCompleteInput(dependencies.stdin ?? process.stdin));
        const request = await createExecutionRequest({
            repo: parsed.repo,
            prompt: input,
            env: dependencies.env,
            allowDirty: parsed.allowDirty,
            commit: parsed.commit,
        });
        const output = await (dependencies.execute ?? executeRequest)(request);
        if (output !== undefined && output !== '') stdout.write(`${output}\n`);
        return 0;
    } catch (error) {
        stderr.write(`flue-agent: ${errorMessage(error)}\n`);
        return 1;
    }
}

export interface RunExecutionOptions {
    store?: RunStore;
    conversationId?: string;
}

/** Submit one request to an in-process Flue runtime and persist its lifecycle. */
export async function executeRequest(
    request: ExecutionRequest,
    options: RunExecutionOptions = {},
): Promise<string> {
    const store = options.store ?? new RunStore();
    const conversationId = options.conversationId ?? randomUUID();
    const workspaces = new WorkspaceManager(store);
    const patches = new PatchManager(store);
    await workspaces.sweep();
    const run = await store.create({
        repository: request.repository,
        configuration: request.configuration,
        conversationId,
    });

    try {
        const workspace = await workspaces.create(
            run.id,
            request.repositoryState,
        );
        await patches.initialize(run.id, request.repositoryState);
        await checkModelConnectivity(request.configuration);
        const orchestrator = createOrchestrator({
            configuration: request.configuration,
            cwd: workspace,
            sandbox: workspaceLocal({
                cwd: workspace,
                env: restrictedAgentEnvironment(),
                checkLimit: () => workspaces.checkLimit(run.id),
                afterMutation: () => patches.capture(run.id),
                commandTimeoutMs: request.configuration.commandTimeoutMs,
                commandAudit: new FileCommandAuditLog(run.locations.auditLog),
            }),
        });
        const runtime = await start({
            agents: [{ agent: orchestrator, name: 'flue-agent-orchestrator' }],
            providers: [createModelProvider(request.configuration)],
        });

        let output: string;
        const limits = new OrchestrationLimits(request.configuration, {
            startedAt: Date.parse(run.timestamps.createdAt),
        });
        const disposePolicy = installOrchestrationPolicy({
            conversationId,
            store,
            runId: run.id,
            limits,
            patches,
        });
        try {
            const handle = init(orchestrator, { id: conversationId });
            output = await blockOnLimit(store, run.id, () =>
                limits.runWithinDeadline(async (signal) => {
                    const abort = () => {
                        void handle.abort();
                    };
                    signal.addEventListener('abort', abort, { once: true });
                    try {
                        let prompt = request.prompt;
                        for (let attempt = 0; ; attempt++) {
                            const receipt = await handle.dispatch(prompt);
                            const text = (
                                await handle.read(receipt, { signal })
                            ).text;
                            const decision = validateOrchestratorResult(text);
                            const latest = await patches.latest(run.id);
                            await patches.capture(
                                run.id,
                                latest?.approvedNewFiles,
                            );
                            const events = (await store.read(run.id)).ledger;
                            if (
                                decision.status !== 'completed' ||
                                !isMutationRun(events)
                            )
                                return text;
                            const gate = completionEligibility(events);
                            if (gate.eligible)
                                return JSON.stringify({
                                    ...decision,
                                    summary: [
                                        decision.summary,
                                        ...gate.warnings.map(
                                            (warning) => `Warning: ${warning}`,
                                        ),
                                    ].join('\n'),
                                });
                            const state = replayLedger(events);
                            const blocked = state.delegations.some(
                                (entry) =>
                                    entry.patchEpoch === state.patchEpoch &&
                                    entry.result?.role === 'reviewer' &&
                                    (entry.result.verdict === 'blocked' ||
                                        entry.result.validation.some(
                                            (check) =>
                                                check.result !== 'passed' &&
                                                check.scope !== 'optional',
                                        )),
                            );
                            if (blocked || attempt >= 5)
                                return JSON.stringify({
                                    ...decision,
                                    status: 'blocked',
                                    summary: `Review gate blocked completion: ${gate.reasons.join('; ')}`,
                                });
                            prompt = `Completion rejected: ${gate.reasons.join('; ')}. Delegate independent review of the current revision if missing. For substantiated changes_requested findings, delegate implementer repair, then fresh independent review. Never waive findings. At most two repair cycles are allowed. Return blocked with unresolved findings if unable to proceed. Preserve the original objective and supply all required briefing sections.`;
                        }
                    } finally {
                        signal.removeEventListener('abort', abort);
                    }
                }),
            );
        } finally {
            await disposePolicy().finally(() => runtime.stop());
        }
        const result = validateOrchestratorResult(output);
        assertOrchestrationIntegrity(result, (await store.read(run.id)).ledger);
        await workspaces.checkLimit(run.id);
        const latest = await patches.latest(run.id);
        await patches.capture(run.id, latest?.approvedNewFiles);
        await workspaces.finish(run.id, result.status);
        let formatted = formatOrchestratorResult(result);
        const events = (await store.read(run.id)).ledger;
        if (result.status === 'completed' && isMutationRun(events)) {
            const approved = await patches.latest(run.id);
            if (!approved)
                throw new Error('Completed run has no patch revision');
            const finalization = await new CommitManager(
                store,
                process.env,
                patches,
            ).finalize(
                run.id,
                approved.revisionHash,
                request.commitRequest ??
                    commitRequestFromPrompt(request.prompt),
            );
            if (finalization.status === 'blocked') {
                await store.update(run.id, { status: 'blocked' });
                return `${formatted}\nBlocked: ${finalization.reason}`;
            }
            formatted +=
                finalization.status === 'committed'
                    ? `\nCommitted approved patch as ${finalization.commit}.`
                    : '\nPublished approved changes without committing.';
        }
        return formatted;
    } catch (error) {
        await workspaces.finish(run.id, 'failed').catch(() => {});
        throw error;
    }
}

async function readCompleteInput(
    input: AsyncIterable<unknown>,
): Promise<string> {
    let result = '';
    for await (const chunk of input) result += String(chunk);
    return result;
}

async function packageVersion(): Promise<string> {
    const source = await readFile(
        new URL('../package.json', import.meta.url),
        'utf8',
    );
    const value: unknown = JSON.parse(source);
    if (
        typeof value !== 'object' ||
        value === null ||
        !('version' in value) ||
        typeof value.version !== 'string'
    ) {
        throw new Error('Package version is unavailable');
    }
    return value.version;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const isEntrypoint =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
    process.exitCode = await runCli(process.argv.slice(2));
}
