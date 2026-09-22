# FLUE-020 — Add behavioral evaluations, end-to-end tests, and documentation

- **Status:** Implemented (real-model execution pending)
- **Difficulty:** XL
- **Depends on:** FLUE-003, FLUE-017, FLUE-018, FLUE-019

## Objective

Demonstrate that the complete system behaves autonomously, safely, and operably against disposable Git repositories.

## Scope

Add real-model behavioral evaluations for:

- trivial work without unnecessary delegation;
- parallel independent exploration;
- a simple edit without unnecessary planning;
- a complex planned change;
- review rejection, repair, and re-review;
- `needs_input` and safe resumption;
- review-loop exhaustion;
- requested and non-requested commits.

Also add an end-to-end disposable-repository test and operator documentation covering installation, configuration, invocation, statuses, resumption, retention, cleanup, and security limitations.

## Implementation

- `tests/acceptance.test.ts`: production runner with model-only substitution;
  real disposable Git repositories, tools, validation, review, publication,
  commit/no-commit flows, and unchanged originals on controlled failures.
- `tests/evals/behavior.test.ts`: eight opt-in real-model behavioral scenarios,
  observable ledger/Git/command assertions, and public evidence artifacts.
- [Operator guide](../../README.md), [evaluation protocol](../evaluations.md),
  and [security limitations/deferred isolation](../security.md).
- Offline verification: 104 tests pass; typecheck and lint pass. Real-model
  evaluations require explicit opt-in and have not yet been executed against a
  deployment model; skipped cases are not evidence of behavioral acceptance.

## Acceptance criteria

- Unit and mocked orchestration suites pass.
- Behavioral evaluations assert observable events and outcomes rather than hidden reasoning or one exact call sequence.
- An end-to-end run modifies, validates, reviews, and publishes to a disposable Git repository.
- Commit and no-commit flows both pass.
- Failure paths leave the original checkout unchanged.
- Documentation prominently limits the MVP to trusted prompts and trusted repositories.
- Future container isolation is recorded as deferred work.
