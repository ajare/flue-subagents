# FLUE-003 — Establish the automated test harness

- **Status:** Implemented
- **Difficulty:** M
- **Depends on:** FLUE-001, FLUE-002

## Objective

Provide deterministic test infrastructure for repository operations, CLI behavior, and model-driven orchestration.

## Scope

- Select and configure the test framework.
- Add fixtures for disposable Git repositories.
- Add mock model/provider and Flue runtime adapters.
- Add helpers for CLI input, stdout, stderr, signals, and exit codes.
- Ensure normal tests do not require a running local model server.
- Configure coverage reporting if appropriate.

## Implementation

Uses Node's built-in test runner with offline Pi faux-provider/embedded Flue
adapters, disposable Git fixtures, subprocess CLI helpers, and a Node 22/24 CI
matrix. See [testing guide](../testing.md) for commands and fixture APIs.

## Acceptance criteria

- Tests run through `npm test` without a model server.
- Tests can create and dispose of isolated Git repository fixtures.
- Mocked subagent delegations can return deterministic results.
- CLI argument and stdin behavior can be exercised in-process or as a subprocess.
- The harness is suitable for CI execution.
