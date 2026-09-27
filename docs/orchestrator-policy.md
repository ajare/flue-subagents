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

Specialists finish using `submit_specialist_result`. Its arguments are checked
inside the original child conversation: a malformed submission records schema
issues, consumes one additional shared delegation attempt, and returns a
corrective instruction to that same child. A second malformed submission is
terminal. The task controller and programmatic delegation share the bounded
`ResultCorrection` state machine; successful correction records `malformed`,
`retry`, then `result`, without a failed delegation or a new agent name. Source
snapshots surround the entire task, including correction. Flue 2.0.3 disallows
subagent lifecycle hooks, so the finish tool performs the in-session check.
Legacy valid text responses remain accepted; malformed text that bypasses the
finish tool fails closed at the parent boundary.

Public ledger events and inspection reports include recovered/terminal contract
diagnostics with role, task ID, retry number and safe schema issues, never the
raw rejected object. Optional reviewer finding `path` and `line` nulls are
omitted before validation; required semantic fields are never invented.

Explorer results have a presentation adapter at this boundary: it accepts a
leading JSON object with an optional Markdown fence (including a missing closing
fence), and preserves a trailing Markdown report headed with `#` as an additional
finding. Explicit `null` values for optional evidence `line` and `symbol` fields
are omitted. Required fields are never inferred, broken JSON is not repaired,
and ambiguous multiple result objects are rejected. The normalized result must
still satisfy the strict explorer schema. Both the ledger and the task response
sent to the orchestrator use that canonical result; the raw model response stays
in the runtime conversation.

Every briefing requires non-empty `Objective:` and `Role task:` headings.
The parser also accepts Markdown headings; for implementers only, an explicit
`Changes to make` section is accepted as `Role task`. Its content is used for
both validation and the ledger task summary. Nested subsections and code
examples are retained, but headings inside fenced code cannot satisfy briefing
requirements. An objective alone still does not supply a role task.
`Acceptance criteria:`, `Constraints:`, `Context and evidence:`, and `Prior
decisions and results:` are optional; an omitted or empty optional section is
interpreted as `None`. Reviewer-specific plan, diff, validation, and limitations
headings remain required. A missing required heading is an
`OrchestrationDefectError`, not a user ambiguity. The failed delegation remains
auditable and cannot be waived. Other explorer or planner failures may be
waived only by an explicit terminal `failureWaivers` entry explaining why the
work is unnecessary; implementer and reviewer failures are never waivable.

The root must call `submit_orchestrator_result` with a schema-validated version 1
decision: `completed`, `blocked`, or `needs_input`, a user-facing summary,
clarification questions, and failure waivers. Tool validation also enforces
cross-field rules before accepting the decision. A finish hook prevents plain
text (including JSON text) from settling successfully, allowing at most two
corrective continuations before failing closed. The result is stored in durable
response metadata; the CLI reads that result, never assistant prose. Each new
delivery clears the previous decision, including on resume. Application deadline
and review/ledger checks remain independent and mandatory.

A `needs_input` decision requires at least one precise question and causes the run
and workspace to be retained for later continuation. A completed decision must
have no questions. Mutation completion additionally requires current independent
review; rejected completion triggers review/repair continuation within the same
run deadline. See [review gating](review-gating.md).
