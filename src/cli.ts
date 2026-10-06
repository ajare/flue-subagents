#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import {
    cancellationSignals,
    checkpointRun,
    loadContinuation,
    lockRun,
} from './resumption.ts';
import { createOrchestrator } from './agents/orchestrator.ts';
import { readStructuredResult } from './agents/structured-result.ts';
import { recordPrompt } from './execution-telemetry.ts';
import { AgentMetrics, metricsPort, startMetricsServer } from './metrics.ts';
import { AgentNames } from './agent-names.ts';
import { ConsoleLog } from './console-log.ts';
import { FileCommandAuditLog } from './command-audit.ts';
import {
    CommitManager,
    commitRequestFromPrompt,
    type CommitRequest,
} from './commit-handling.ts';
import {
    type AgentConfiguration,
    resolveConfiguration,
    subagentConfiguration,
    SUBAGENT_ROLES,
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
import {
    buildReport,
    cleanupRun,
    formatReport,
    listRuns,
    publicEvents,
    saveOutcome,
    TRUST_WARNING,
    type RunReport,
} from './reporting.ts';
import { workspaceLocal } from './sandboxes/workspace-local.ts';
import { WorkspaceManager } from './workspaces.ts';

export interface ExecutionRequest {
    prompt: string;
    repository: string;
    configuration: AgentConfiguration;
    repositoryState: GitPreflightResult;
    /** Captured from the original user input, never inferred from agent output. */
    commitRequest?: CommitRequest;
    /** Stop orchestration after the first started sub-agent failure. */
    failFast?: boolean;
    /** Context utilization percentage that triggers automatic compaction. */
    autoCompactionPercent?: number;
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
    modelTransport?: RunExecutionOptions['modelTransport'];
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
    configPath?: string;
    repo: string;
    prompt?: string;
    allowDirty: boolean;
    commit: boolean;
    failFast: boolean;
    autoCompactionPercent?: number;
}

export const HELP = `Usage:
  flue-agent list [--json]
  flue-agent inspect <run-id> [--json]
  flue-agent cleanup <run-id> | cleanup --expired
  flue-agent resume <run-id> [answer] [--json]
  flue-agent [--repo <path>] [--allow-dirty] [--commit] [--fail-fast] [--auto-compaction <percent>] "<prompt>"
  printf '%s' "<prompt>" | flue-agent [--repo <path>] [--allow-dirty] [--commit] [--fail-fast] [--auto-compaction <percent>]

Submit one engineering objective for autonomous execution.

Options:
  --json         Emit NDJSON events and a final JSON report
  --repo <path>  Repository to operate on (default: current directory)
  --config <path> Use this configuration file instead of flue-agent.config.json
  --allow-dirty  Permit and fingerprint staged, unstaged, and untracked changes
  --commit       Commit the approved published patch (hooks run normally)
  --fail-fast    End the run when any sub-agent fails (default: off)
  --auto-compaction <percent>
                 Compact when context reaches this percentage (exclusive 0–100)
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
    let configPath: string | undefined;
    let prompt: string | undefined;
    let allowDirty = false;
    let commit = false;
    let failFast = false;
    let autoCompactionPercent: number | undefined;
    let positionalOnly = false;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index] as string;
        if (!positionalOnly && argument === '--') {
            positionalOnly = true;
            continue;
        }
        if (!positionalOnly && (argument === '--help' || argument === '-h')) {
            return {
                action: 'help',
                repo,
                allowDirty,
                commit,
                failFast,
                autoCompactionPercent,
            };
        }
        if (
            !positionalOnly &&
            (argument === '--version' || argument === '-v')
        ) {
            return {
                action: 'version',
                repo,
                allowDirty,
                commit,
                failFast,
                autoCompactionPercent,
            };
        }
        if (!positionalOnly && argument === '--allow-dirty') {
            allowDirty = true;
            continue;
        }
        if (!positionalOnly && argument === '--commit') {
            commit = true;
            continue;
        }
        if (!positionalOnly && argument === '--fail-fast') {
            failFast = true;
            continue;
        }
        if (!positionalOnly && argument === '--auto-compaction') {
            const value = argv[index + 1];
            if (value === undefined || value === '') {
                throw new CliUsageError(
                    '--auto-compaction requires a percentage',
                );
            }
            autoCompactionPercent = parseAutoCompactionPercent(value);
            index += 1;
            continue;
        }
        if (!positionalOnly && argument.startsWith('--auto-compaction=')) {
            autoCompactionPercent = parseAutoCompactionPercent(
                argument.slice('--auto-compaction='.length),
            );
            continue;
        }
        if (
            !positionalOnly &&
            (argument === '--config' || argument.startsWith('--config='))
        ) {
            const value =
                argument === '--config'
                    ? argv[++index]
                    : argument.slice('--config='.length);
            if (!value || value.startsWith('--'))
                throw new CliUsageError('--config requires a path');
            configPath = resolve(cwd, value);
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

    return {
        action: 'execute',
        configPath,
        repo,
        prompt,
        allowDirty,
        commit,
        failFast,
        autoCompactionPercent,
    };
}

/**
 * Convert parsed user input into the canonical request consumed by the runner.
 * Prompt edge whitespace is normalized so quoted and piped forms are equal.
 */
export async function createExecutionRequest(options: {
    repo: string;
    configPath?: string;
    prompt: string;
    env?: NodeJS.ProcessEnv;
    allowDirty?: boolean;
    commit?: boolean;
    failFast?: boolean;
    autoCompactionPercent?: number;
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
        configPath: options.configPath,
        env: options.env,
    });
    return {
        prompt,
        repository,
        configuration,
        repositoryState,
        commitRequest: commitRequestFromPrompt(prompt, options.commit),
        failFast: options.failFast ?? false,
        autoCompactionPercent: options.autoCompactionPercent,
    };
}

/** Run the CLI with injectable streams and execution for deterministic tests. */
export async function runCli(
    argv: readonly string[],
    dependencies: CliDependencies = {},
): Promise<number> {
    let consoleLog: ConsoleLog;
    let logRunOutput = true;
    let json = false;
    let finalReport: RunReport | undefined;
    const seen = new Map<string, number>();
    const emit = (event: object) => {
        if (json) stdout.write(`${JSON.stringify(event)}\n`);
        else
            stderr.write(
                `${Object.entries(event)
                    .filter(
                        ([key, value]) =>
                            !['type', 'sequence', 'runId'].includes(key) &&
                            value !== undefined,
                    )
                    .map(
                        ([key, value]) =>
                            `${key}: ${key === 'ts' && typeof value === 'number' ? new Date(value).toISOString() : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`,
                    )
                    .join(' | ')}\n`,
            );
    };
    const store = new RunStore({
        env: dependencies.env,
        onUpdate: (run) => {
            if (logRunOutput) consoleLog.attachRun(store.runDirectory(run.id));
            for (const event of publicEvents(run).filter(
                (event) => event.sequence > (seen.get(run.id) ?? 0),
            ))
                emit(event);
            seen.set(run.id, run.ledger.length);
        },
    });
    try {
        consoleLog = new ConsoleLog(store.root);
    } catch (error) {
        (dependencies.stderr ?? process.stderr).write(
            `flue-agent: cannot create console logs: ${errorMessage(error)}\n`,
        );
        return 1;
    }
    const stdout = consoleLog.tee(
        'stdout',
        dependencies.stdout ?? process.stdout,
    );
    const stderr = consoleLog.tee(
        'stderr',
        dependencies.stderr ?? process.stderr,
    );
    const executionOptions: RunExecutionOptions = {
        store,
        modelTransport: dependencies.modelTransport,
        metricsEnv: dependencies.env,
        credentialEnv: dependencies.env,
        onReport: (report) => {
            consoleLog.attachRun(store.runDirectory(report.id));
            finalReport = report;
        },
        onEvent: emit,
    };
    const display = (output?: string) => {
        if (finalReport)
            stdout.write(
                `${json ? JSON.stringify(finalReport) : formatReport(finalReport)}\n`,
            );
        else if (output)
            stdout.write(
                `${json ? JSON.stringify({ type: 'result', summary: output }) : output}\n`,
            );
        return finalReport?.exitCode ?? 0;
    };
    try {
        const separator = argv.indexOf('--');
        argv = argv.filter((argument, index) => {
            if (argument === '--json' && (separator < 0 || index < separator)) {
                json = true;
                return false;
            }
            return true;
        });
        if (['list', 'inspect', 'cleanup'].includes(argv[0] ?? '')) {
            logRunOutput = false;
            const [command, id] = argv;
            if (command === 'list') {
                if (argv.length !== 1)
                    throw new CliUsageError('Usage: flue-agent list [--json]');
                const runs = await listRuns(store);
                stdout.write(
                    json
                        ? `${JSON.stringify({ type: 'runs', runs: runs.map((run) => ({ id: run.id, status: run.status, workspace: run.locations.workspace })) })}\n`
                        : `${runs.map((run) => `${run.id}: ${run.status} — ${run.locations.workspace ?? 'no workspace'}`).join('\n') || 'No runs.'}\n`,
                );
            } else {
                if (!id || argv.length !== 2)
                    throw new CliUsageError(
                        `Usage: flue-agent ${command} <run-id>`,
                    );
                if (command === 'inspect') {
                    const report = await buildReport(store, id);
                    stdout.write(
                        `${json ? JSON.stringify(report) : formatReport(report)}\n`,
                    );
                } else {
                    if (id === '--expired') {
                        for (const run of await listRuns(store))
                            await cleanupRun(store, run.id, true);
                    } else await cleanupRun(store, id);
                    stdout.write(
                        json
                            ? `${JSON.stringify({ type: 'cleanup', target: id })}\n`
                            : `Workspace cleanup complete: ${id}\n`,
                    );
                }
            }
            return 0;
        }
        if (argv[0] === 'resume') {
            stderr.write(`${TRUST_WARNING}\n`);
            if (!argv[1] || argv.length > 3)
                throw new CliUsageError(
                    'Usage: flue-agent resume <run-id> [answer]',
                );
            const answer =
                argv[2] ??
                (dependencies.stdin || !process.stdin.isTTY
                    ? await readCompleteInput(
                          dependencies.stdin ?? process.stdin,
                      )
                    : undefined);
            const output = await resumeRequest(argv[1], answer, {
                ...executionOptions,
            });
            return display(output);
        }
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
            configPath: parsed.configPath,
            prompt: input,
            env: dependencies.env,
            allowDirty: parsed.allowDirty,
            commit: parsed.commit,
            failFast: parsed.failFast,
            autoCompactionPercent: parsed.autoCompactionPercent,
        });
        stderr.write(`${TRUST_WARNING}\n`);
        const output = dependencies.execute
            ? await dependencies.execute(request)
            : await executeRequest(request, executionOptions);
        return display(output);
    } catch (error) {
        if (finalReport) return display();
        if (json)
            stdout.write(
                `${JSON.stringify({ type: 'error', message: errorMessage(error), exitCode: 1 })}\n`,
            );
        else stderr.write(`flue-agent: ${errorMessage(error)}\n`);
        return 1;
    } finally {
        consoleLog.close();
    }
}

export interface RunExecutionOptions {
    /** FLUE_METRICS_PORT enables a loopback Prometheus endpoint during execution. */
    metricsEnv?: NodeJS.ProcessEnv;
    /** Host secrets are used by transport only, never saved or passed to sandboxes. */
    credentialEnv?: NodeJS.ProcessEnv;
    /** Embedded callers/tests may replace only the model transport. */
    modelTransport?: {
        check: typeof checkModelConnectivity;
        create: typeof createModelProvider;
    };
    store?: RunStore;
    conversationId?: string;
    signal?: AbortSignal;
    resumeId?: string;
    answer?: string;
    onReport?: (report: RunReport) => void;
    onEvent?: (event: object) => void;
}

export async function resumeRequest(
    id: string,
    answer?: string,
    options: RunExecutionOptions = {},
): Promise<string> {
    const store = options.store ?? new RunStore();
    const unlock = await lockRun(store, id);
    try {
        const request = await loadContinuation(store, id, answer);
        return await executeRequest(request, {
            ...options,
            store,
            resumeId: id,
            answer,
        });
    } finally {
        await unlock();
    }
}

/** Submit one request to an in-process Flue runtime and persist its lifecycle. */
export async function executeRequest(
    request: ExecutionRequest,
    options: RunExecutionOptions = {},
): Promise<string> {
    const port = metricsPort(options.metricsEnv ?? process.env);
    const store = options.store ?? new RunStore();
    const existing = options.resumeId
        ? await store.read(options.resumeId)
        : undefined;
    const conversationId =
        existing?.conversationId ?? options.conversationId ?? randomUUID();
    const controller = new AbortController();
    const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
    const workspaces = new WorkspaceManager(store);
    const patches = new PatchManager(store);
    if (!existing) await workspaces.sweep();
    const run =
        existing ??
        (await store.create({
            repository: request.repository,
            configuration: request.configuration,
            conversationId,
        }));

    const unlock = existing ? undefined : await lockRun(store, run.id);
    const report = async (summary: string) => {
        await saveOutcome(store, run.id, summary);
        options.onReport?.(await buildReport(store, run.id));
        return summary;
    };
    const removeSignals = cancellationSignals(controller);
    const metrics = new AgentMetrics(run.id);
    let metricsServer:
        | Awaited<ReturnType<typeof startMetricsServer>>
        | undefined;
    try {
        signal.throwIfAborted();
        if (port !== undefined)
            metricsServer = await startMetricsServer(metrics, port);
        if (existing) {
            await rm(join(store.runDirectory(run.id), 'resume.json'));
            await store.update(run.id, { status: 'running' });
        }
        const workspace =
            existing?.locations.workspace ??
            (await workspaces.create(run.id, request.repositoryState));
        if (!existing)
            await patches.initialize(run.id, request.repositoryState);
        const providerMetadata = await (
            options.modelTransport?.check ?? checkModelConnectivity
        )(request.configuration, { signal, env: options.credentialEnv });
        const specialistConfigurations = SUBAGENT_ROLES.filter(
            (role) => request.configuration.subagents?.[role] !== undefined,
        ).map((role) => subagentConfiguration(request.configuration, role));
        for (const configuration of specialistConfigurations) {
            await (options.modelTransport?.check ?? checkModelConnectivity)(
                configuration,
                { signal, env: options.credentialEnv },
            );
        }
        const agentNames = new AgentNames(
            join(store.runDirectory(run.id), 'agent-names.json'),
        );
        // Seed legacy runs too, so resuming never restarts a role's numbering.
        for (const { action } of run.ledger) {
            if (action.type === 'start') agentNames.get(action.id, action.role);
        }
        const commandAudit = new FileCommandAuditLog(run.locations.auditLog);
        const orchestrator = createOrchestrator({
            configuration: request.configuration,
            cwd: workspace,
            autoCompactionPercent: request.autoCompactionPercent,
            sandbox: workspaceLocal({
                cwd: workspace,
                signal,
                env: restrictedAgentEnvironment(),
                checkLimit: () => workspaces.checkLimit(run.id),
                afterMutation: () => patches.capture(run.id),
                commandTimeoutMs: request.configuration.commandTimeoutMs,
                commandAudit: {
                    record: async (record) => {
                        await commandAudit.record(record);
                        const {
                            timestamp,
                            command,
                            durationMs,
                            exitCode,
                            outcome,
                        } = record;
                        options.onEvent?.({
                            type: 'command',
                            runId: run.id,
                            ts: timestamp,
                            agent: record.agent,
                            taskId: record.taskId,
                            command,
                            durationMs,
                            exitCode,
                            outcome,
                        });
                    },
                },
            }),
        });
        const runtime = await start({
            db: sqlite(join(store.runDirectory(run.id), 'conversation.sqlite')),
            agents: [{ agent: orchestrator, name: 'flue-agent-orchestrator' }],
            providers: [
                (options.modelTransport?.create ?? createModelProvider)(
                    request.configuration,
                    options.credentialEnv,
                ),
                ...specialistConfigurations.map((configuration) =>
                    (options.modelTransport?.create ?? createModelProvider)(
                        configuration,
                        options.credentialEnv,
                    ),
                ),
            ],
        });

        let output: string;
        const limits = new OrchestrationLimits(request.configuration, {
            startedAt: existing
                ? Date.now()
                : Date.parse(run.timestamps.createdAt),
        });
        const disposePolicy = installOrchestrationPolicy({
            configuration: request.configuration,
            conversationId,
            store,
            runId: run.id,
            limits,
            patches,
            agentNames,
            failFast: request.failFast,
        });
        try {
            const handle = init(orchestrator, { id: conversationId });
            output = await blockOnLimit(store, run.id, () =>
                limits.runWithinDeadline(async (deadlineSignal) => {
                    const executionSignal = AbortSignal.any([
                        signal,
                        deadlineSignal,
                    ]);
                    const abort = () => {
                        void handle.abort();
                    };
                    executionSignal.addEventListener('abort', abort, {
                        once: true,
                    });
                    try {
                        executionSignal.throwIfAborted();
                        let prompt = existing
                            ? options.answer?.trim() ||
                              'Continue the interrupted objective using the existing conversation and workspace. Inspect partial work before retrying operations.'
                            : request.prompt;
                        for (let attempt = 0; ; attempt++) {
                            const text = await recordPrompt(
                                join(
                                    store.runDirectory(run.id),
                                    'execution-telemetry.jsonl',
                                ),
                                run.id,
                                conversationId,
                                async () => {
                                    const receipt =
                                        await handle.dispatch(prompt);
                                    const reply = await handle.read(receipt, {
                                        signal: executionSignal,
                                    });
                                    return JSON.stringify(
                                        readStructuredResult(reply.metadata),
                                    );
                                },
                                request.configuration.maxOutputTokens,
                                request.configuration.contextWindow,
                                options.onEvent,
                                agentNames,
                                providerMetadata?.maxOutputTokens,
                                metrics,
                            );
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
                        executionSignal.removeEventListener('abort', abort);
                        if (executionSignal.aborted) await handle.abort();
                    }
                }),
            );
        } finally {
            await disposePolicy().finally(() => runtime.stop());
        }
        signal.throwIfAborted();
        const result = validateOrchestratorResult(output);
        assertOrchestrationIntegrity(result, (await store.read(run.id)).ledger);
        await workspaces.checkLimit(run.id);
        const latest = await patches.latest(run.id);
        await patches.capture(run.id, latest?.approvedNewFiles);
        if (result.status === 'needs_input')
            await checkpointRun(store, run.id, request);
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
                return await report(`Blocked: ${finalization.reason}`);
            }
            formatted +=
                finalization.status === 'committed'
                    ? `\nCommitted approved patch as ${finalization.commit}.`
                    : '\nPublished approved changes without committing.';
        }
        return await report(
            result.status === 'needs_input'
                ? `${formatted}\nResume: flue-agent resume ${run.id} "<answer>"`
                : formatted,
        );
    } catch (error) {
        if (signal.aborted) {
            for (const entry of replayLedger((await store.read(run.id)).ledger)
                .delegations) {
                if (!entry.completedAt)
                    await store.update(run.id, {
                        ledgerAction: {
                            type: 'failure',
                            id: entry.id,
                            message:
                                'Delegation interrupted; inspect partial work before retrying',
                        },
                    });
            }
            await checkpointRun(store, run.id, request).catch(() => {});
            await workspaces.finish(run.id, 'interrupted');
            return await report(
                `Interrupted run ${run.id}. Resume: flue-agent resume ${run.id}`,
            );
        }
        const failedRun = await store.read(run.id);
        await workspaces
            .finish(
                run.id,
                failedRun.status === 'completed' ? 'blocked' : 'failed',
            )
            .catch(() => {});
        await report(errorMessage(error));
        throw error;
    } finally {
        removeSignals();
        try {
            await metricsServer?.close();
        } finally {
            await unlock?.();
        }
    }
}

function parseAutoCompactionPercent(value: string): number {
    const percentage = Number(value);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100) {
        throw new CliUsageError(
            '--auto-compaction must be a number greater than 0 and less than 100',
        );
    }
    return percentage;
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
