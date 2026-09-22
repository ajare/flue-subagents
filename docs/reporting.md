# Reporting and run management

`flue-agent --json "objective"` and `flue-agent resume <id> [answer] --json`
emit newline-delimited JSON: public delegation/command events followed by one
`type: "report"`, `schemaVersion: 1` outcome. Human mode streams concise events
to stderr and prints the same report data to stdout. The trusted-local warning
always goes to stderr (including JSON mode). Worktrees are not security sandboxes.

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
