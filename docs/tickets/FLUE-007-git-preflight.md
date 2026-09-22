# FLUE-007 — Implement Git repository preflight checks

- **Status:** Proposed
- **Difficulty:** M
- **Depends on:** FLUE-003, FLUE-005

## Objective

Ensure mutation starts only from a recognized and reproducible Git repository state.

## Scope

- Reject directories that are not Git repositories.
- Capture repository identity, HEAD, branch, index state, and worktree state.
- Refuse dirty repositories by default.
- Add explicit `--allow-dirty` support.
- Fingerprint the complete allowed dirty starting state.
- Detect unsupported states that prevent safe worktree or publication operations.

## Acceptance criteria

- Non-Git directories are always rejected.
- Clean repositories receive a reproducible starting fingerprint.
- Dirty repositories require explicit permission.
- The dirty-state fingerprint detects subsequent changes.
- Preflight failures occur before agent or workspace mutation.
