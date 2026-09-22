# FLUE-015 — Implement autonomous orchestrator policy

- **Status:** Implemented
- **Difficulty:** L
- **Depends on:** FLUE-012, FLUE-013, FLUE-014

## Objective

Allow the orchestrator to choose an effective delegation strategy from the engineering objective without user-authored workflow instructions.

## Scope

- Let the orchestrator decide whether and how much to explore.
- Let it decide whether planning is needed based on complexity and risk.
- Encourage parallel delegation for independent read-only work.
- Require complete, self-contained handoffs.
- Prevent direct repository mutation by the orchestrator.
- Return `needs_input` for consequential unresolved ambiguity.
- Separate application policy from the user's engineering prompt.

## Acceptance criteria

- Trivial questions can complete without unnecessary delegation.
- Complex tasks can fan out exploration and invoke planning.
- The orchestrator cannot bypass writer serialization or capability restrictions.
- Missing subagent context is treated as an orchestration defect.
- Ambiguous consequential choices produce precise clarification questions.

## Implementation

`src/agents/orchestrator.ts` contains application-owned strategy instructions,
a strict self-contained handoff template, and the terminal decision contract.
`src/orchestrator-policy.ts` validates terminal outcomes and specialist
briefings, wraps every live Flue task with the shared ledger, budget, and role
concurrency gates, and fails closed on unresolved delegation failures. The CLI
persists `needs_input` rather than treating it as completion. See
[autonomous orchestrator policy](../orchestrator-policy.md).
