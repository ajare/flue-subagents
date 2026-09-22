# FLUE-010 — Define structured subagent result contracts

- **Status:** Implemented
- **Difficulty:** M
- **Depends on:** FLUE-002, FLUE-003

## Objective

Give orchestration boundaries stable, validated result shapes while retaining room for explanatory text.

## Scope

Define contracts for:

- explorer findings, evidence, and open questions;
- planner steps, affected files and symbols, tests, and risks;
- implementer changes, commands, results, and unresolved issues;
- reviewer verdict, findings, validation, and limitations.

Support reviewer verdicts `approved`, `approved_with_limitations`, `changes_requested`, and `blocked`. Allow one corrective retry for malformed output and count it toward the delegation budget.

## Acceptance criteria

- Every role contract validates representative successful and failing results.
- Implementer and reviewer results cannot proceed when malformed.
- Validation errors can be supplied in one corrective retry.
- Explorer or planner failure can be ignored only when orchestration explicitly determines their work is unnecessary.
- Contracts are versioned or designed for safe persistence.
