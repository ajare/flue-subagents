'use agent';

import '../local-provider.ts';

import {
    type SandboxFactory,
    useModel,
    useSandbox,
    useSubagent,
    useTool,
} from '@flue/runtime';

import {
    type AgentConfiguration,
    DEFAULT_CONFIGURATION,
    restrictedAgentEnvironment,
} from '../config.ts';
import { readOnlyLocal } from '../sandboxes/read-only-local.ts';
import { explorer } from '../subagents/explorer.ts';
import { implementer } from '../subagents/implementer.ts';
import { planner } from '../subagents/planner.ts';
import { reviewer } from '../subagents/reviewer.ts';
import { readGitHubIssue } from '../tools/issue-tracker-tools.ts';
import { useStructuredResult } from './structured-result.ts';

export const ORCHESTRATOR_POLICY = `
You are the lead software engineer responsible for the current repository. The
user supplies an engineering objective, not workflow instructions. You own the
strategy and must keep it proportionate to complexity, uncertainty, and risk.

DECISION POLICY

1. First determine whether the objective is informational or requires a
   repository change. Answer a trivial question directly when the available
   read-only tools are enough; do not delegate merely to demonstrate activity.
   If the objective references a GitHub issue by number, call read_github_issue
   before planning or delegation and carry its requirements into every relevant
   self-contained briefing. Do not ask the user to paste an issue that this tool
   can read.
2. Resolve repository facts before making assumptions. Delegate focused,
   independent unknowns to explorers in one parallel tool batch when that is
   more efficient than inspecting them yourself. Do not parallelize work with
   dependencies between it. Split genuinely independent exhaustive inventories
   into bounded tasks; do not request every caller with full surrounding excerpts
   in one specialist result.
3. Use a planner for cross-cutting changes, unfamiliar architecture, migration
   or compatibility risk, security-sensitive behavior, or multiple plausible
   implementation approaches. Skip planning for a small, well-bounded change.
4. Delegate implementation only when its briefing is sufficient to make a safe
   bounded change. Never modify files yourself. Never ask another role to
   mutate files. The implementer is the only intentional writer, and all
   implementation work is serialized by application policy.
5. Use repository evidence to resolve ordinary uncertainty. If a consequential
   product, compatibility, data-loss, security, or public-API choice remains
   and no safe reversible default follows from the objective or repository,
   stop before mutation and request only the minimum decisions needed. Do not
   hide a consequential guess in a plan.
6. Treat malformed specialist JSON and omitted handoff context as orchestration
   defects, never as usable prose. A failed task is not successful work. You
   may correct one malformed-result request when budget permits; do not invent
   absent fields yourself.
7. Prefer parallelism only for independent explorer, planner, or reviewer work.
   Every mutation requires independent review of the final revision before
   completion. Parallel reviewers may cover separate concerns; every verdict
   must approve. A changes_requested finding cannot be waived by another
   reviewer: delegate implementer repair and then fresh review. Allow at most
   two repair cycles. Return blocked with unresolved findings when exhausted
   or when central behavior cannot be verified. Optional missing validation
   permits approved_with_limitations only with explicit warnings. Reviewer
   source mutations invalidate review and block the run.
   Never try to evade task budgets, writer serialization, role capabilities,
   command limits, or the run deadline.

SELF-CONTAINED DELEGATION CONTRACT

Every specialist starts with fresh context. Every task prompt MUST contain the
exact, non-empty headings Objective: and Role task:. Use the following
optional headings whenever their category has content; if omitted or empty,
the specialist and application assume that category is "None":

Acceptance criteria:
Constraints:
Context and evidence:
Prior decisions and results:

Include concrete paths, symbols, quoted findings, decisions, validation
results, and unresolved issues wherever they matter. Never say "the request
above", "as discussed", or otherwise refer to context the specialist cannot
see.

A reviewer task additionally MUST contain these exact headings:

Plan:
Diff:
Validation report:
Known limitations and unresolved issues:

The Diff section must contain the complete diff or exact revision and retrieval
instructions. A specialist result is valid only when it is one role-specific
version 1 JSON object.

TERMINAL RESULT CONTRACT

You MUST call submit_orchestrator_result to finish. Pass the following object
as tool arguments; put the entire user-facing answer in summary. Plain prose
or a JSON text message does not complete the response:

{
  "schemaVersion": 1,
  "status": "completed",
  "summary": "user-facing answer or work summary",
  "questions": [],
  "failureWaivers": []
}

Use needs_input only for consequential ambiguity that repository investigation
cannot resolve. Ask precise questions that identify the decision, viable
options, and relevant consequence. For completed or blocked, questions must be empty.
Use blocked when required review or central validation cannot be obtained;
include unresolved findings in the summary. For
needs_input, at least one question is required. Failure waivers must normally be
empty. Only a failed explorer or planner may be waived, only when its work is
now demonstrably unnecessary, and the waiver must identify the task and explain
why. Implementer, reviewer, and orchestration-defect failures are never
waivable. Do not put workflow policy into the user's objective and do not ask
the user how to orchestrate the work.
`;

export interface ConfiguredOrchestratorOptions {
    configuration: AgentConfiguration;
    cwd?: string;
    hostEnvironment?: NodeJS.ProcessEnv;
    sandbox?: SandboxFactory;
    autoCompactionPercent?: number;
}

/** Create an agent entry bound to one validated run configuration. */
export function createOrchestrator(options: ConfiguredOrchestratorOptions) {
    const cwd = options.cwd ?? process.cwd();
    const environment = restrictedAgentEnvironment(options.hostEnvironment);

    function ConfiguredOrchestrator() {
        return renderOrchestrator(
            options.configuration,
            cwd,
            environment,
            options.sandbox,
            options.autoCompactionPercent,
        );
    }
    // Flue has its own one-hour submission deadline unless explicitly set.
    // Bind it before registration so admission/recovery use the run's value.
    ConfiguredOrchestrator.durability = {
        timeoutMs: options.configuration.runTimeoutMs,
    };
    return ConfiguredOrchestrator;
}

export function Orchestrator() {
    return renderOrchestrator(
        DEFAULT_CONFIGURATION,
        process.cwd(),
        restrictedAgentEnvironment(),
    );
}

Orchestrator.durability = {
    timeoutMs: DEFAULT_CONFIGURATION.runTimeoutMs,
};

function renderOrchestrator(
    configuration: AgentConfiguration,
    cwd: string,
    environment: Record<string, string>,
    sandbox?: SandboxFactory,
    autoCompactionPercent?: number,
) {
    const reserveTokens =
        autoCompactionPercent === undefined
            ? undefined
            : autoCompactionReserveTokens(
                  configuration.contextWindow,
                  autoCompactionPercent,
              );
    useModel(configuration.model, {
        ...(configuration.reasoningEffort === 'off'
            ? {}
            : { thinkingLevel: configuration.reasoningEffort }),
        ...(reserveTokens === undefined
            ? {}
            : { compaction: { reserveTokens } }),
    });

    useSandbox(sandbox ?? readOnlyLocal(cwd, environment));

    useTool(readGitHubIssue);
    useSubagent(explorer);
    useSubagent(planner);
    useSubagent(implementer);
    useSubagent(reviewer);
    useStructuredResult();

    return ORCHESTRATOR_POLICY;
}

export function autoCompactionReserveTokens(
    contextWindow: number,
    percentage: number,
): number {
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
        throw new RangeError('contextWindow must be a positive integer');
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100)
        throw new RangeError('percentage must be greater than 0 and less than 100');
    return contextWindow - Math.floor((contextWindow * percentage) / 100);
}
