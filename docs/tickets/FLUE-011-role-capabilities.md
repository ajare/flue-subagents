# FLUE-011 — Implement role-specific capability boundaries

- **Status:** Proposed
- **Difficulty:** L
- **Depends on:** FLUE-002, FLUE-003, FLUE-008

## Objective

Expose only the repository capabilities each subagent role needs.

## Scope

- Keep source-mutation tools exclusive to implementers.
- Provide read, grep, glob, and narrowly allowlisted inspection commands to explorers and planners.
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
