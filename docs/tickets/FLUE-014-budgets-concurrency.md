# FLUE-014 — Implement orchestration budgets and concurrency controls

- **Status:** Implemented
- **Difficulty:** L
- **Depends on:** FLUE-004, FLUE-011, FLUE-013

## Objective

Bound autonomous execution while permitting useful read-only parallelism.

## Scope

Enforce configurable defaults of:

- four concurrent read-only tasks;
- one active implementer;
- 20 total delegations, including malformed-output retries;
- two repair cycles after initial implementation;
- 30-minute total runtime;
- 10-minute command timeout;
- 10 GB workspace size.

Distinguish policy-limit exhaustion from infrastructure failure.

## Acceptance criteria

- Read-only task concurrency never exceeds its configured limit.
- Mutating implementation is serialized.
- Every delegation and retry consumes budget.
- Total runtime, command timeout, repair, and workspace limits are enforced.
- Limit exhaustion produces `blocked` with the exhausted limit identified.

## Implementation

`src/orchestration-limits.ts` provides shared delegation and repair counters,
fair role-specific concurrency gates, total-runtime cancellation, and the typed
blocked outcome. `delegateWithLimits()` is the policy entry point that applies
those controls around ledger-backed delegation. Workspace and command limits
are enforced by `WorkspaceManager` and `workspaceLocal`; the CLI now applies
the total deadline to live Flue execution. See
[`docs/orchestration-limits.md`](../orchestration-limits.md).
