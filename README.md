# flue-subagents

An autonomous coding agent using Flue orchestration, specialist delegation,
independent review, and Git-worktree publication.

> **Trusted-local MVP: use only trusted prompts and trusted repositories.**
> Worktrees and role tool restrictions are not a security sandbox. Model-driven
> commands and repository tests run on your host with your user permissions.
> Do not run this against untrusted code or where sensitive host data is accessible.
> Hardened isolation is deferred; see [security limitations](docs/security.md).
For container packaging and startup commands, see [Podman](docs/podman.md).

## Install and configure

Requirements: Node **>=22.19.0**, Git, and a reachable OpenAI-compatible model
server supporting tool calls. From this checkout:

```sh
npm ci
npm run typecheck
npm test
npm link                        # optional: installs the flue-agent command
export FLUE_AGENT_ENDPOINT=http://localhost:8731/v1
export FLUE_AGENT_MODEL=halogen/qwen-3.8-flash-next
```

Without `npm link`, replace `flue-agent` with `node /absolute/path/to/src/cli.ts`.
This is a source installation, not a published package or compiled distribution.
The current provider sends the fixed API key `local`; endpoints requiring other
credentials are not supported by configuration. Model execution may incur costs.
See [configuration](docs/configuration.md) for project JSON, environment overrides,
context/output limits, timeouts, concurrency, and budgets. Configuration is read
from the target repository, not necessarily the agent's installation directory.

## Prometheus metrics

Set `FLUE_METRICS_PORT=9464` when starting or resuming a run to expose
`http://127.0.0.1:9464/metrics` (GET). Disabled by default; the listener is
loopback-only and closes when execution finishes. Use distinct ports for
concurrent CLI processes. A port already in use fails the run.

```sh
FLUE_METRICS_PORT=9464 flue-agent "Explain the parser architecture"
# From another terminal while the run is executing:
curl http://127.0.0.1:9464/metrics
```

All series have `run_id`, `agent_name` (e.g. `explorer-1`), and `agent_type`
(e.g. `explorer`) labels, including the `orchestrator`:

- `flue_agent_active`: gauge, 1 while executing, 0 after completion.
- `flue_agent_tool_calls_active`: gauge counting tool calls currently active for
  the agent; parallel calls can make this greater than 1.
- `flue_agent_index`: gauge containing the agent's one-based creation index
  (orchestrator 1, then 2, 3, and so on), with `status="queued"` before gate
  admission and `status="active"` while executing; removed when the agent stops.
- `flue_agent_status`: separate one-hot gauge with a `status` label:
  `running`, `completed`, `failed`, or `interrupted`.
- `flue_agent_context_tokens`: gauge containing the latest reported input
  context (prompt) size for the agent, including cached tokens.
- `flue_agent_output_tokens_total`: counter of reported output tokens;
  missing provider usage is not estimated.
- `flue_agent_last_turn_output_tokens`: gauge containing the reported output-token
  count for the latest completed model turn.
- `flue_agent_turns_total`: counter of model turns observed for the agent,
  including turns whose response reports an error.
- `flue_agent_max_tokens_clamped_from`: gauge containing the latest provider-reported
  requested output-token limit before clamping.
- `flue_agent_max_tokens_clamped_to`: gauge containing the latest provider-reported
  output-token limit after clamping.

The context and output-token clamp gauges appear after an agent's first turn with
those provider statistics and retain the latest valid values when later statistics
are unavailable. The last-turn output gauge is omitted until a completed turn reports
valid usage, and is removed if the next completed turn has no valid output count.
Queued agents
have `status="queued"` in `flue_agent_index`; `flue_agent_active` remains 0 until
execution starts. Terminal agents remain visible until endpoint shutdown except for
`flue_agent_index`, whose series is removed when its agent stops. Status describes
execution, not review approval or the final run outcome. Metrics cover this invocation only (not historical
runs), contain no prompt/output content, and reset on process restart/resume.
Tool-call activity begins at `tool_start` and ends when Flue commits the terminal
`tool` event, which can be slightly later than execution itself. It resets when the
agent terminates. Choose a scrape interval appropriate for short-lived agents; a
scrape can miss an entire short run. Per-agent names create new time series for each
delegation.

## Run

To bind-mount a repository into the packaged application and supply a startup
prompt, see the [Podman build and run guide](docs/podman.md).

See the [prompt examples guide](docs/prompt-examples.md) for repository questions,
bug fixes, features, refactors, reviews, commits, and clarification workflows.

```sh
flue-agent --repo /path/to/trusted/repo "Fix the parser and add regression tests"
printf '%s' 'Explain the parser architecture' | flue-agent --repo /path/to/repo
flue-agent --repo /path/to/repo --commit "Fix the parser and test it"
flue-agent --repo /path/to/repo --json "Update the documentation"
```

Use a clean checkout by default. `--allow-dirty` explicitly permits fingerprinted
local changes; publication still refuses conflicting or changed originals.
Changes are developed in a managed worktree, validated and independently reviewed
before publication. By default, approved changes are published **without a
commit**. `--commit` (or an explicit commit request in the original prompt)
authorizes a commit; commit hooks run normally. Do not request commits in a
prompt if you want a no-commit run. Avoid concurrent edits during execution.

## Outcomes and continuation

| Status | Exit | Operator action |
| --- | ---: | --- |
| `completed` | 0 | Inspect the published diff or commit and validation report |
| `failed` | 1 | Inspect the error; correct infrastructure or start a new run |
| `needs_input` | 2 | Answer the specific question using `resume` |
| `blocked` | 3 | Inspect unresolved findings/limits; do not treat as success |
| `running` | 4 | Inspection status, not a successful terminal outcome |
| `interrupted` | 130 | Inspect retained work, then resume if safe |

```sh
flue-agent list
flue-agent inspect <run-id> --json
flue-agent resume <run-id> "Answer to the clarification"
flue-agent resume <interrupted-run-id>
```

Ctrl-C/SIGTERM attempt graceful cancellation and checkpointing. Resume preserves
conversation, configuration, review ledger and original commit authority; it
checks both original and workspace fingerprints. Changed/missing checkouts,
expired workspaces, absent checkpoints, and non-resumable statuses fail closed.
Do not bypass these checks. SIGKILL/power loss can leave stale locks: verify the
owning process has exited before manual investigation, never blindly delete locks.
See [resumption](docs/resumption.md) and [reporting](docs/reporting.md).

## Retention and cleanup

Run data defaults to the platform user-data directory; set `FLUE_AGENT_DATA_DIR`
to choose a private directory outside the target repository. Failed, blocked,
interrupted and needs-input workspaces are retained by default for **7 days**
(`FLUE_AGENT_RETENTION`). Cleanup occurs opportunistically, not via a background
scheduler. Completed unpublished work is retained for safety.

```sh
flue-agent cleanup <run-id>       # deletes workspace; forfeits resumption
flue-agent cleanup --expired
```

Cleanup keeps run records/reports; it is not a full data-erasure command. Private
conversation databases and command audit artifacts may contain sensitive code
or outputs. Restrict access and manage archival/deletion separately after runs
are stopped. See [workspaces](docs/workspaces.md) and [publication](docs/patch-publication.md).

## Verification

- `npm test`: offline unit, mocked orchestration and disposable-repository tests.
- `npm run test:e2e`: production runner with only model transport mocked; real
  tools, validation commands, independent review, publication and commits.
- `FLUE_AGENT_EVAL=1 npm run test:eval`: opt-in real-model behavioral evaluations.

See [testing](docs/testing.md) and [behavioral evaluation protocol](docs/evaluations.md).
