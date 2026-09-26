import type { Dirent } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replayLedger } from './delegation-ledger.ts';
import { loadPerformanceSummary } from './performance-summary.ts';
import { PatchManager } from './patch-publication.ts';
import { lockRun } from './resumption.ts';
import type { RunStore, RunRecord, RunStatus } from './run-storage.ts';
import { WorkspaceManager } from './workspaces.ts';

export const EXIT_CODES: Readonly<Record<RunStatus, number>> = {
    completed: 0,
    failed: 1,
    needs_input: 2,
    blocked: 3,
    interrupted: 130,
    running: 4,
};
export const TRUST_WARNING =
    'TRUSTED-LOCAL EXECUTION: agent commands can modify files and execute repository code. Use only trusted prompts and repositories; worktrees are not a security sandbox.';

/** Deliberately excludes conversation messages, model reasoning and raw tool output. */
export function publicEvents(run: RunRecord) {
    const state = replayLedger(run.ledger);
    return run.ledger.map(({ sequence, at, action, agent, taskId }) => {
        const entry =
            'id' in action
                ? state.delegations.find((item) => item.id === action.id)
                : undefined;
        return {
            type: 'event' as const,
            runId: run.id,
            sequence,
            ts: typeof at === 'number' ? at : Date.parse(at),
            event: action.type,
            agent: agent ?? entry?.role ?? 'orchestrator',
            taskId: taskId ?? entry?.id,
            role: entry?.role,
            task: entry?.task,
            durationMs: entry?.completedAt
                ? Date.parse(entry.completedAt) - Date.parse(entry.startedAt)
                : undefined,
            result:
                action.type === 'result' ? entry?.result?.summary : undefined,
            verdict:
                action.type === 'result' && entry?.result?.role === 'reviewer'
                    ? entry.result.verdict
                    : undefined,
        };
    });
}

export async function buildReport(store: RunStore, id: string) {
    const run = await store.read(id);
    const state = replayLedger(run.ledger);
    const results = state.delegations.flatMap((entry) =>
        entry.result ? [entry.result] : [],
    );
    const reviews = state.delegations
        .filter(
            (entry) =>
                entry.patchEpoch === state.patchEpoch &&
                entry.result?.role === 'reviewer',
        )
        .map((entry) => entry.result)
        .filter((result) => result?.role === 'reviewer');
    let summary: string | null = null;
    try {
        summary = await readFile(
            join(store.runDirectory(id), 'outcome.txt'),
            'utf8',
        );
    } catch (error) {
        if (!isMissing(error)) throw error;
    }
    const patch = await new PatchManager(store).latest(id);
    return {
        type: 'report' as const,
        schemaVersion: 1,
        id,
        status: run.status,
        exitCode: EXIT_CODES[run.status],
        summary,
        repository: run.repository.path,
        timestamps: run.timestamps,
        durationMs:
            Date.parse(run.timestamps.completedAt ?? run.timestamps.updatedAt) -
            Date.parse(run.timestamps.createdAt),
        agentPerformance: await loadPerformanceSummary(join(store.runDirectory(id), 'execution-telemetry.jsonl')),
        changedFiles: patch?.changes.map((change) => change.path) ?? [],
        validation: results.flatMap((result) =>
            result.role === 'implementer'
                ? result.commands
                : result.role === 'reviewer'
                  ? result.validation
                  : [],
        ),
        review: reviews,
        reducedConfidence: reviews.some(
            (review) => review.verdict === 'approved_with_limitations',
        ),
        limitations: reviews.flatMap((review) => review.limitations),
        risks: [
            ...results.flatMap((result) =>
                result.role === 'implementer'
                    ? result.unresolvedIssues
                    : result.role === 'planner'
                      ? result.risks
                      : result.role === 'explorer'
                        ? result.openQuestions
                        : [],
            ),
            ...reviews.flatMap((review) =>
                review.findings
                    .filter((finding) => finding.severity !== 'note')
                    .map((finding) => finding.description),
            ),
        ],
        workspace: run.locations.workspace,
        resume: ['needs_input', 'interrupted'].includes(run.status)
            ? `flue-agent resume ${id}`
            : null,
    };
}
export type RunReport = Awaited<ReturnType<typeof buildReport>>;
export function formatReport(report: RunReport): string {
    return [
        `Run ${report.id}: ${report.status} (${report.durationMs} ms)`,
        report.reducedConfidence ? 'WARNING: REDUCED-CONFIDENCE APPROVAL' : '',
        ...report.risks.map((risk) => `UNRESOLVED RISK: ${risk}`),
        report.summary ?? '',
        `Changed files: ${report.changedFiles.join(', ') || 'none'}`,
        ...report.validation.map(
            (check) =>
                `Validation: ${check.result}: ${check.command} — ${check.summary}`,
        ),
        ...report.review.map(
            (review) => `Review: ${review.verdict} — ${review.summary}`,
        ),
        ...report.limitations.map((limitation) => `Limitation: ${limitation}`),
        `Retained workspace: ${report.workspace ?? 'none'}`,
        report.resume ? `Resume: ${report.resume}` : '',
        'Performance summary:',
        `Wall-clock time: ${(report.durationMs / 1000).toFixed(3)} s`,
        ...report.agentPerformance.map((agent) =>
            `${agent.agent}: ${agent.averageTokensPerSecond === null ? 'token/s unavailable' : `${agent.averageTokensPerSecond.toFixed(2)} token/s`} (${agent.llmCalls} LLM calls; ${agent.measuredCalls} timed)`,
        ),
    ]
        .filter(Boolean)
        .join('\n');
}
export async function saveOutcome(
    store: RunStore,
    id: string,
    summary: string,
): Promise<void> {
    await writeFile(join(store.runDirectory(id), 'outcome.txt'), summary, {
        mode: 0o600,
    });
}
export async function listRuns(store: RunStore): Promise<RunRecord[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(store.runsDirectory, { withFileTypes: true });
    } catch (error) {
        if (isMissing(error)) return [];
        throw error;
    }
    const runs = [];
    for (const entry of entries)
        if (entry.isDirectory()) runs.push(await store.read(entry.name));
    return runs.sort((a, b) =>
        b.timestamps.createdAt.localeCompare(a.timestamps.createdAt),
    );
}
export async function cleanupRun(
    store: RunStore,
    id: string,
    expiredOnly = false,
): Promise<void> {
    await store.read(id);
    const unlock = await lockRun(store, id);
    try {
        const manager = new WorkspaceManager(store);
        if (expiredOnly) await manager.cleanupExpired(id);
        else await manager.remove(id);
    } finally {
        await unlock();
    }
}
function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
