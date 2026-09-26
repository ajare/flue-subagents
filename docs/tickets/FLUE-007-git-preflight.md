# FLUE-007 — Implement Git repository preflight checks

- **Status:** Implemented
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

## Implementation

`src/git-preflight.ts` performs read-only Git discovery, rejects unsafe
repository states, and captures the canonical worktree and Git directories,
filesystem identity, HEAD, branch/detached state, logical index contents,
tracked worktree diffs, and all non-ignored untracked file contents. Unchanged
submodule gitlinks remain part of the logical index while submodule working-tree
contents are excluded.
Length-delimited SHA-256 hashes provide
separate index and worktree fingerprints plus one repository fingerprint.
`assertGitFingerprint` rechecks that state for later publication guards.

The CLI runs preflight before configuration, run creation, model connectivity,
or agent execution. Repositories must be clean unless `--allow-dirty` is
provided. Bare and unborn repositories, sparse checkouts, unresolved entries,
modified submodule references, and in-progress merge/rebase/sequencer
operations fail closed.

## Acceptance criteria

- Non-Git directories are always rejected.
- Clean repositories receive a reproducible starting fingerprint.
- Dirty repositories require explicit permission.
- The dirty-state fingerprint detects subsequent changes.
- Preflight failures occur before agent or workspace mutation.
