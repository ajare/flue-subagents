# FLUE-008 — Implement temporary worktree lifecycle

- **Status:** Implemented
- **Difficulty:** L
- **Depends on:** FLUE-006, FLUE-007

## Objective

Keep autonomous work out of the original checkout until its final patch has passed review.

## Scope

- Create a temporary Git worktree for each run.
- Direct all agent filesystem operations to the temporary worktree.
- Reproduce an explicitly allowed dirty starting state when applicable.
- Track workspace size against the configured limit.
- Delete successful workspaces after publication.
- Retain failed, blocked, interrupted, and `needs_input` workspaces for the configured period.
- Implement idempotent cleanup primitives.

## Acceptance criteria

- Agent work cannot directly alter the original checkout.
- Workspace paths are recorded in run state.
- Cleanup is safe to repeat.
- Retention follows run outcome and configuration.
- Exceeding the workspace limit produces `blocked` without publishing changes.

## Implementation notes

- `src/workspaces.ts` owns provisioning, exact dirty-state verification,
  measured size limits, outcome retention, and idempotent cleanup.
- `src/sandboxes/workspace-local.ts` confines ordinary filesystem paths and
  checks workspace size around mutations and during commands.
- CLI execution and inherited subagents use the recorded workspace.
- Successful cleanup is exposed as an explicit publication callback; completed
  runs retain their workspaces until FLUE-009 confirms publication.
- See [workspace behavior and trusted-local limitations](../workspaces.md).
- Covered by `tests/workspaces.test.ts` using disposable Git repositories.
