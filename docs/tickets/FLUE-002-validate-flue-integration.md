# FLUE-002 — Validate Flue orchestration integration

- **Status:** Completed
- **Difficulty:** L
- **Depends on:** FLUE-001

## Objective

Prove that Flue exposes the programmatic orchestration and observability capabilities required by the design before building around them.

## Scope

- Prototype Flue's programmatic runtime API.
- Verify that multiple task calls in one batch execute concurrently.
- Determine how delegation events and structured subagent results can be observed.
- Verify cancellation, conversation resumption, and result handling.
- Determine how review evidence can be associated with a patch revision.
- Document the selected integration architecture and framework limitations.

## Acceptance criteria

- A minimal programmatic agent delegates parallel tasks successfully.
- The prototype exposes enough information to build the delegation ledger.
- Cancellation and continuation behavior are documented from observed results.
- Any missing framework capability has a documented, feasible alternative.
- The architecture decision is recorded for dependent tickets.

## Implementation

- Executable integration probe: [`src/prototypes/flue-integration.ts`](../../src/prototypes/flue-integration.ts)
- Architecture decision and observed limitations: [`docs/architecture/0001-flue-runtime-integration.md`](../architecture/0001-flue-runtime-integration.md)
- Run with `npm run probe:flue`; no external model server is required.
