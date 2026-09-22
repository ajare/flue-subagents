# flue-subagents

An autonomous coding agent using Flue orchestration, specialist delegation,
independent review, and Git-worktree publication.

> **Trusted-local MVP: use only trusted prompts and trusted repositories.**
> Worktrees and role tool restrictions are not a security sandbox. Model-driven
> commands and repository tests run on your host with your user permissions.
> Do not run this against untrusted code or where sensitive host data is accessible.
> Container isolation is deferred; see [security limitations](docs/security.md).

## Install and configure

Requirements: Node **>=22.19.0**, Git, and a reachable OpenAI-compatible model
server supporting tool calls. From this checkout:

```sh
npm ci
npm run typecheck
npm test
npm link                        # optional: installs the flue-agent command
export FLUE_AGENT_ENDPOINT=http://localhost:8080/v1
export FLUE_AGENT_MODEL=local/ornith
```

Without `npm link`, replace `flue-agent` with `node /absolute/path/to/src/cli.ts`.
This is a source installation, not a published package or compiled distribution.
The current provider sends the fixed API key `local`; endpoints requiring other
credentials are not supported by configuration. Model execution may incur costs.
See [configuration](docs/configuration.md) for project JSON, environment overrides,
context/output limits, timeouts, concurrency, and budgets. Configuration is read
from the target repository, not necessarily the agent's installation directory.

## Run

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
