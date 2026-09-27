# Reporting and run management

`flue-agent --json "objective"` and `flue-agent resume <id> [answer] --json`
emit newline-delimited JSON: public delegation/command events followed by one
`type: "report"`, `schemaVersion: 1` outcome. Human mode streams concise events
to stderr and prints the same report data to stdout. The trusted-local warning
always goes to stderr (including JSON mode). Worktrees are not security sandboxes.

Command and ledger-event timestamps are stored as epoch milliseconds. Public
JSON events expose that number as `ts`; human output formats `ts` as a UTC ISO
string. Legacy ledger entries with ISO timestamps remain readable. Each command
and ledger event includes `agent` (`orchestrator` for root activity). Each new
delegation receives a unique per-run name such as `explorer-1`, `explorer-2`, or
`reviewer-1`, used consistently in public messages, command audits, ledger events,
and execution telemetry. `taskId` remains the runtime correlation key, while the
delegation's `role` still controls permissions and result validation. Names are
allocated before concurrency queuing, including failed tasks, and persisted in
`agent-names.json` so continuations and resumed runs do not reuse numbers. New
runs restart numbering. Flue's private conversation records retain its native
role names and task IDs. Ownership is persisted with new audit and ledger records. For legacy
records, reporting uses the delegation role where available, otherwise
`orchestrator`.

Reports include the persisted status, outcome summary, changed file paths,
validation commands and results, current-revision reviews, limitations, risks,
timing, retained workspace and continuation command. Reduced-confidence approval
and unresolved risks have prominent human labels and explicit JSON fields.
Reported planner risks and implementer issues are conservative historical signals;
they are not automatically considered resolved by later approval. Validation
includes historical checks; reviews cover the current patch epoch only.

The public event projection uses validated delegation contracts and command
metadata, never raw model responses, conversation databases, hidden reasoning,
or command stdout/stderr. Existing private runtime storage and command audit
files are not exposed by `inspect`; these local artifacts still require trusted
access. Structured task summaries and command strings can contain repository
information: reporting is not a secrets-redaction service.

Each completed model turn also emits an `llm_output` event with `agent`,
`taskId` (for delegated work), `turnId`, `outputTokens`, and
`outputTokenPercentage` (count / configured max output tokens, clamped to [0, 1];
`null` when usage is unavailable). Counts are per model
response, including tool-call responses, not per command or patch checkpoint.
Unavailable usage is `null`, not zero; failed turns can still report consumed
tokens. `configuredOutputTokenLimit` records the request budget, while
`providerMaxOutputTokens` records the provider's `max_tokens_cap` advertised by
the selected `/models` entry (`null` when unavailable). These events are also
saved in `execution-telemetry.jsonl`.

Every `llm_output` also reports `contextTokens` (the input context for that
turn, including cached tokens), `contextWindow` (the configured token capacity),
and `contextUtilization` (`contextTokens / contextWindow`, clamped to [0, 1]).
These apply to both orchestrator and sub-agent turns; `agent` and `taskId`
identify the owner. Context size uses provider `usage.prompt_tokens`, falling
back to runtime input plus cache-read and cache-write counts. Missing or invalid
usage yields `null` size/utilization, not zero. This is a per-response snapshot,
not a continuous measurement or a sum across turns, and excludes generated output.

When supplied by the OpenAI-compatible provider, `llm_output` also includes the
full `timings` and `usage` objects, preserving provider field names and nested
usage details. Timings include prefill/generation milliseconds and tokens/sec,
cache/prefix counts, disk restore statistics, and draft-token counts. Missing
objects are omitted; no client-side time-to-first-token metric is added. Repeated
final streaming metadata is merged, not summed. Human output renders these
objects as JSON. Only these statistics are retained, not response content.

## End-of-run performance summary

Human reports end with wall-clock elapsed seconds and average generation token/s
for each named agent instance (including the orchestrator). JSON reports expose
`durationMs` and `agentPerformance`; `inspect` reconstructs these from persisted
telemetry. Wall-clock time spans run creation to completion, including pauses
between resumptions, not the sum of parallel task durations.

Each named agent's rate is `1000 * sum(timings.predicted_n) / sum(timings.predicted_ms)`
across its model calls, including reasoning output and calls from resumed prompts.
It is **not** an arithmetic mean of per-call rates, nor tokens divided by run
wall time. Prefill and tool time are excluded. Separate delegations of the same
role have separate rows; older telemetry that stored only roles remains grouped
by role. Duplicate turn records and task-level totals are not double-counted.
`llmCalls` and `measuredCalls` show coverage. If any call lacks valid timing,
including an interrupted call, the average is `null` (human: unavailable);
token/time totals then cover only measured calls. Older runs without per-turn
telemetry cannot supply rates.

## Execution timing and token usage

Each prompt dispatch (including continuations and review-gate retries) appends to
`execution-telemetry.jsonl` in the run directory. Records carry `runId` and a
unique `promptId`, with `prompt_start` / `prompt_end` boundaries.

- `subagent_start` / `subagent_end`: task ID, unique agent name, UTC start/end timestamps,
  status and total provider-reported output tokens across that task's LLM turns.
  `usageComplete: false` means the token count is only a known subtotal; absent
  usage is not estimated from response text.
- `orchestrator_llm_start` / `orchestrator_llm_end`: turn ID, request start and
  response end timestamps, model/purpose on start, status and output tokens
  (`null` when unavailable). These intervals exclude tool execution.

Unfinished spans are marked interrupted when dispatch exits. A hard process kill
may leave only start records. Resuming appends new prompt records rather than
replacing previous telemetry. Logs contain no prompts, model responses or reasoning
and are local artifacts, not part of the public `inspect` report.

## Console transcripts

Every CLI invocation tees its stdout and stderr to separate, byte-preserving
`stdout.log` and `stderr.log` files under
`<data-dir>/logs/<timestamp>-<invocation-id>/`. This includes human and JSON
output, warnings, errors, final reports, and direct JavaScript runtime/library
writes to the process streams during the CLI invocation. Help, management
commands, and failures before run creation therefore have transcripts too.

Once an execution is associated with a run, the same output is also appended to
`<data-dir>/runs/<run-id>/stdout.log` and `stderr.log`. Earlier output from that
invocation (including the trust warning) is copied in once. Resume appends rather
than overwriting. Management commands keep their output in invocation logs only;
`inspect` does not alter the inspected run. The structured audit and telemetry
files remain separate and unchanged.

Transcripts preserve stream contents, not cross-stream ordering. They are not
redacted and can contain sensitive diagnostics; directories/files are created
with owner-only permissions. They are retained with the other logs, not removed
by workspace cleanup. Logging starts inside the CLI, so process-loader failures
before CLI startup and OS-level messages are outside its capture boundary.

## Exit codes

| Status | Code |
| --- | --- |
| completed | 0 |
| failed | 1 |
| needs_input | 2 |
| blocked | 3 |
| running (inspection data only) | 4 |
| interrupted | 130 |

Usage, configuration and pre-run errors return 1. JSON pre-run errors have
`type: "error"`. Management commands return 0 when successful, regardless of the
inspected run's status; the report retains that run's exit code.

## Management

- `flue-agent list [--json]`: list durable run IDs, statuses and retained workspaces.
- `flue-agent inspect <run-id> [--json]`: reconstruct the public report without
  invoking a model or modifying the repository.
- `flue-agent cleanup <run-id> [--json]`: explicitly delete the managed workspace,
  keeping records and reports. This forfeits continuation of retained work.
- `flue-agent cleanup --expired [--json]`: apply configured retention to stopped,
  unsuccessful workspaces. Completed unpublished and running workspaces are kept.

Retention also applies when a run stops and opportunistically on new execution.
Cleanup uses exclusive execution locks and existing Git-worktree ownership checks;
it refuses arbitrary workspace paths. Repeated cleanup is harmless. Execution
locks also protect suspended runs while resuming. A stale lock after a hard crash
fails closed and requires operator investigation; cleanup does not steal locks.
Run directories must not be symlinks. Storage defaults to the platform user-data
directory and can be selected with `FLUE_AGENT_DATA_DIR`.
