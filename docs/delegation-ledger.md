# Delegation and revision ledger

`RunRecord.ledger` is an ordered event log in `run.json`, committed by the same
atomic replacement as status, conversation, and location updates. Use
`RunStore.update(id, { ledgerAction, ... })` to commit an event with other run
changes. Updates through one store instance are serialized, including parallel
delegations. As with existing run storage, multiple processes/store instances
must not write the same run concurrently.

`replayLedger` validates the log and derives delegation records in **start
order**, independent of completion order. IDs are application-owned; parent IDs
must identify an active delegation. Records contain task, role, times, validated
result or failure, before/after patch identities, malformed-result diagnostics,
and corrective retry count. Loaded logs are deeply frozen. Earlier version-1
records without a ledger load with an empty log (and no review approval).

`delegateWithLedger` wraps the existing structured-result validator and budget:
start, malformed output, corrective attempt, result, and failure all persist.
Use explicit IDs when a caller needs to link child tasks. The wrapper permits
one corrective retry, which consumes the existing delegation budget. Autonomous
model-driven tasks are wired through `OrchestrationPolicyController`, which
uses Flue's task interception boundary to enforce this application-owned
ledger. The ledger itself remains independent of Flue event shapes.

`PatchManager.capture` automatically records the full revision hash and diff
hash at mutation boundaries, including unchanged diffs with changed workspace
content. Callers must capture after every mutation, including failed commands
that may have changed files. Reviewer tasks must receive the exact captured
diff (or its retrieval instructions), not merely a model's implementation
summary. A review binds to the patch at delegation start; changes during review
make it stale too. Patch epochs ensure that restoring an old hash never revives
an earlier approval. Unchanged captures do not invalidate approval.

`completionEligibility` derives conservative eligibility: a captured patch, no
active delegations or unresolved failures, and a current validated approval
without blocking findings. It accepts `approved_with_limitations`, retaining the
limitations in the validated result. It never uses final model prose. Further
failure waivers, repair policy, validation requirements, and enforcement of run
completion/publication are the responsibilities of FLUE-015/016; this function
does not itself transition status or publish files.

Patch artifact files and `run.json` are separate atomic documents. If recording
a captured revision fails, capture fails; repeating capture reconciles the
ledger even when the artifact is already current. Resume must recapture the
workspace before using eligibility (safe resumption is FLUE-018).
