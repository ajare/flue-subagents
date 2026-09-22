# FLUE-012 — Implement the four specialist subagents

- **Status:** Proposed
- **Difficulty:** M
- **Depends on:** FLUE-010, FLUE-011

## Objective

Provide clearly described specialists that the orchestrator can select without requiring delegation instructions in user prompts.

## Scope

- Refine the existing `explorer`, `planner`, and `implementer` definitions.
- Add the `reviewer` definition.
- Write capability-oriented names and descriptions.
- Require every delegated prompt to be self-contained.
- Require role-specific structured results.
- Ensure roles do not assume a mandatory fixed phase sequence.
- Ensure the reviewer independently inspects evidence rather than trusting implementer claims.

## Acceptance criteria

- All four definitions load and validate through Flue.
- Each role receives only its intended capabilities.
- Mocked delegations produce valid role-specific results.
- Reviewer instructions require the objective, relevant plan, diff, validation report, and known limitations.
- Subagents do not depend on unseen parent-conversation context.
