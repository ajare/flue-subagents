# FLUE-019 — Implement reporting and run-management commands

- **Status:** Implemented
- **Difficulty:** L
- **Depends on:** FLUE-006, FLUE-013, FLUE-016, FLUE-018

## Objective

Make autonomous activity and outcomes understandable to humans and automation without exposing private model reasoning.

## Scope

- Stream high-level role, task, timing, command, result, and verdict events.
- Add concise human-readable output and optional JSON output.
- Report changed files, validation, limitations, review, and retained workspace.
- Define stable exit codes for every run status.
- Add `list`, `inspect`, and `cleanup` commands.
- Apply retention expiry to unsuccessful workspaces.
- Display the trusted-local execution warning for mutation runs.

## Implementation

See [reporting and run management](../reporting.md) for output contracts, exit
codes, retention, privacy boundaries, and management commands. Coverage lives in
`tests/reporting.test.ts` alongside existing workspace lifecycle tests.

## Acceptance criteria

- Human and JSON reports describe the same outcome.
- Private chain-of-thought is not logged or displayed.
- Every terminal status maps to a documented exit code.
- Retained runs can be listed, inspected, and cleaned safely.
- Reports identify reduced-confidence approval and unresolved risks prominently.
