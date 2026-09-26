# FLUE-004 — Implement configuration and model-provider resolution

- **Status:** Implemented
- **Difficulty:** M
- **Depends on:** FLUE-002, FLUE-003

## Objective

Resolve and validate runtime configuration without requiring orchestration details in the user's prompt.

## Scope

- Implement precedence: CLI flags, environment variables, project configuration, then defaults.
- Configure model ID, endpoint, context window, output-token limit, and reasoning effort.
- Configure concurrency, delegation, timeout, retention, and workspace limits.
- Preserve `halogen/qwen-3.8-flash-next` and `http://localhost:8731/v1` as defaults.
- Preserve Flue's restricted environment-variable allowlist.
- Check model connectivity before creating a worktree.
- Report the effective non-secret configuration for diagnostics.

## Implementation

Configuration resolution and validation live in `src/config.ts`; the configured
OpenAI-compatible provider and pre-workspace connectivity probe live in
`src/model-provider.ts`. The orchestrator factory binds the selected model,
reasoning effort, working directory, and restricted command environment to a
run. See the [configuration guide](../configuration.md) for sources, options,
defaults, and security behavior.

## Acceptance criteria

- Every supported source participates in the documented precedence order.
- Invalid values fail before workspace creation.
- The defaults reproduce the current local provider setup.
- Connectivity failures produce a clear infrastructure error.
- No host secrets are passed to agent commands by default.
