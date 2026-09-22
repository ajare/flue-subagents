# Autonomous orchestrator policy

The root agent receives application policy as its system instruction while the
user's engineering objective remains the unmodified dispatch message. The
policy chooses work by capability rather than a fixed phase sequence:

- answer trivial informational requests directly;
- fan out independent repository questions to explorers;
- use planning for cross-cutting, risky, or ambiguous changes;
- send sufficiently specified mutation work only to the implementer; and
- stop with `needs_input` when repository evidence cannot resolve a
  consequential choice.

Every delegated prompt uses the headings defined in
`ORCHESTRATOR_POLICY`. `OrchestrationPolicyController` observes Flue task intent
and wraps the actual task execution. Before a child runs it persists the ledger
start, consumes the shared delegation budget, checks the complete briefing, and
enters the read-only or implementer concurrency gate. It validates the child's
role-specific result before persisting completion. Thus a direct model call to
Flue's built-in `task` tool cannot bypass application limits, writer
serialization, the durable ledger, or structured-result validation.

A missing heading is an `OrchestrationDefectError`, not a user ambiguity. The
failed delegation remains auditable and cannot be waived. Other explorer or
planner failures may be waived only by an explicit terminal `failureWaivers`
entry explaining why the work is unnecessary; implementer and reviewer
failures are never waivable.

The root returns a version 1 JSON decision with `completed`, `blocked`, or `needs_input`, a
user-facing summary, clarification questions, and failure waivers. The
application validates this decision and the ledger independently. A
`needs_input` decision requires at least one precise question and causes the run
and workspace to be retained for later continuation. A completed decision must
have no questions. Mutation completion additionally requires current independent
review; rejected completion triggers review/repair continuation within the same
run deadline. See [review gating](review-gating.md).
