# FLUE-004 — Implement configuration and model-provider resolution

- **Status:** Proposed
- **Difficulty:** M
- **Depends on:** FLUE-002, FLUE-003

## Objective

Resolve and validate runtime configuration without requiring orchestration details in the user's prompt.

## Scope

- Implement precedence: CLI flags, environment variables, project configuration, then defaults.
- Configure model ID, endpoint, context window, output-token limit, and reasoning effort.
- Configure concurrency, delegation, timeout, retention, and workspace limits.
- Preserve `local/ornith` and `http://localhost:8080/v1` as defaults.
- Preserve Flue's restricted environment-variable allowlist.
- Check model connectivity before creating a worktree.
- Report the effective non-secret configuration for diagnostics.

## Acceptance criteria

- Every supported source participates in the documented precedence order.
- Invalid values fail before workspace creation.
- The defaults reproduce the current local provider setup.
- Connectivity failures produce a clear infrastructure error.
- No host secrets are passed to agent commands by default.
