# FLUE-011 — Implement role-specific capability boundaries

- **Status:** Implemented
- **Difficulty:** L
- **Depends on:** FLUE-002, FLUE-003, FLUE-008

## Objective

Expose only the repository capabilities each subagent role needs.

## Scope

- Keep source-mutation tools exclusive to implementers.
- Provide read, grep, glob, narrowly allowlisted inspection commands, and structured read-only GitHub issue access to agents.
- Give reviewers read and command access without intentional mutation tools.
- Add command timeouts and cancellation signals.
- Bind ordinary path operations to the temporary worktree.
- Preserve Flue's restricted command environment.
- Record commands, durations, exits, stdout, and stderr for auditing.

## Acceptance criteria

- Explorer and planner tools cannot intentionally write repository files.
- The orchestrator has no mutation tools.
- Only one implementer can execute mutating work at a time.
- Timed-out and cancelled commands terminate their process groups.
- Agent commands operate against the temporary worktree rather than the original checkout.

## Implementation notes

- The sandbox-provided tool set contains only `read`, `grep`, and `glob`;
  explorer and planner mount the structured, allowlisted `inspect_repository`
  Git tool, while only implementer mounts file mutation and unrestricted
  development-command tools.
- The orchestrator and every specialist mount `read_github_issue`, which accepts
  only a positive issue number and runs a fixed-shape `gh issue view` command for
  the workspace repository. It returns the full body, labels, author, state, URL,
  and comments without exposing an unrestricted shell string.
- `MutationCoordinator` serializes all implementer writes, replacements, and
  commands, including concurrent tool calls from separate task sessions.
- Tool cancellation signals are forwarded to sandbox execution. Flue's local
  adapter enforces deadlines and kills POSIX process groups on timeout or
  cancellation; the workspace adapter caps every requested timeout at the run
  configuration.
- `workspaceLocal` confines ordinary paths to the temporary worktree and keeps
  the restricted environment established by configuration. Its command wrapper
  writes timestamped NDJSON audit records with command, cwd, duration, exit,
  stdout, stderr, and outcome through `FileCommandAuditLog`.
- Reviewer command capability is defined separately in
  `src/tools/review-tools.ts` for the reviewer introduced by FLUE-012; it adds
  validation-command access but no file mutation API.
- Covered by `tests/role-capabilities.test.ts`, including process-group
  cancellation, timeout capping, auditing, the inspection allowlist, fixed-shape
  issue reads, and mutation serialization.
