# FLUE-012 — Implement the four specialist subagents

- **Status:** Implemented
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

## Implementation notes

- The four Flue definitions are in `src/subagents/`. Each catalog description
  states the specialist's capability, and each instruction set requires a
  complete briefing and a version 1 role-specific JSON result.
- The orchestrator mounts all four specialists, permits capability-driven use
  without a fixed phase sequence, and defines the content required in every
  fresh-context handoff.
- The reviewer mounts only non-mutating validation command access and is told to
  inspect the diff, surrounding code, and command evidence independently rather
  than trust implementer summaries.
- `tests/subagents.test.ts` exercises real Flue task delegation with mocked model
  responses, validates all returned contracts, and inspects each child's tool
  roster for capability isolation.
