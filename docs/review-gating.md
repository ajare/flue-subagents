# Review and completion gating

Mutation runs (implementer delegation or a changed captured revision) cannot
transition to `completed` without current independent review. Publication checks
the same evidence as well as the exact workspace revision. Read-only answers do
not need a review. The CLI does not publish automatically.

All reviewer results for the current patch epoch are aggregated conservatively:
`changes_requested`, `blocked`, blocking findings, failures, and active tasks
prevent approval. Another review cannot override a negative verdict. Changing a
revision invalidates all prior approvals, including changing it back later.
The ledger binds each verdict to the before/after revision and diff hash.

The runtime snapshots before and after reviewer tasks. Reviewers can execute in
parallel; implementers are excluded for the entire review interval. Detected
source mutation invalidates review and blocks the run. The workspace is retained
under the configured blocked-run retention policy, not silently incorporated or
published. Snapshots cover tracked and nonignored untracked content, not ignored
build artifacts. This is change detection, not an OS security boundary.

The CLI rejects premature completion and asks the orchestrator to delegate
repair followed by fresh independent review. Implementer delegations after review
consume repair cycles, with a hard maximum of two (or a lower configured limit).
Exhaustion blocks the run and preserves findings in the ledger. Continuations
share the original deadline and delegation budget; repeated no-progress completion
attempts also block rather than looping indefinitely.

Validation checks may specify `scope: central | optional`; omission is treated as
central. A failed or unrun central check blocks approval. Optional missing checks
require `approved_with_limitations` and explicit limitations, surfaced as warnings
in successful CLI output. Review may also use direct inspection evidence rather
than executable checks. A limitations verdict without limitations is not approval.
