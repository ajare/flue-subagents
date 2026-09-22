# FLUE-018 — Implement cancellation and safe resumption

- **Status:** Implemented
- **Difficulty:** XL
- **Depends on:** FLUE-006, FLUE-008, FLUE-013, FLUE-015

## Objective

Preserve recoverable work while stopping model and command execution promptly after interruption or clarification requests.

## Scope

- Handle Ctrl-C and termination signals.
- Cancel active model calls and command process groups.
- Mark interrupted runs consistently.
- Preserve workspaces for `interrupted` and `needs_input` outcomes.
- Add `flue-agent resume <run-id> [answer]` with stdin support where appropriate.
- Verify repository identity and fingerprints before continuation.
- Refuse incompatible continuation while retaining inspectability and cleanup.

## Implementation

See [cancellation and resumption](../resumption.md) for CLI usage and fail-closed recovery boundaries.

## Acceptance criteria

- Cancellation terminates active command process groups.
- Interrupted run state remains readable after process exit.
- A compatible run resumes with the same conversation and workspace.
- `needs_input` answers continue the existing orchestration context.
- Repository changes after suspension prevent unsafe continuation.
