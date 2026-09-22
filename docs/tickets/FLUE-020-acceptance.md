# FLUE-020 — Add behavioral evaluations, end-to-end tests, and documentation

- **Status:** Proposed
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

## Acceptance criteria

- Unit and mocked orchestration suites pass.
- Behavioral evaluations assert observable events and outcomes rather than hidden reasoning or one exact call sequence.
- An end-to-end run modifies, validates, reviews, and publishes to a disposable Git repository.
- Commit and no-commit flows both pass.
- Failure paths leave the original checkout unchanged.
- Documentation prominently limits the MVP to trusted prompts and trusted repositories.
- Future container isolation is recorded as deferred work.
