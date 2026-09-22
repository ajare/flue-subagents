# Cancellation and resumption

Ctrl-C and SIGTERM abort the active conversation and workspace shell process
 groups, then persist an `interrupted` run and a continuation checkpoint. The
run ID is printed after shutdown. `needs_input` results also save a checkpoint.
Workspaces remain subject to the configured retention policy and explicit cleanup.

```sh
flue-agent resume <run-id>
flue-agent resume <run-id> "Answer to the clarification"
printf '%s' 'Answer to the clarification' | flue-agent resume <run-id>
```

A clarification requires a nonempty answer. Resume reuses the saved configuration,
conversation ID, durable SQLite conversation, delegation ledger, and workspace;
it does not create a new run or infer new commit authorization from an answer.
Each continuation gets a new execution deadline. Existing ledger review gates
remain in force, and interrupted delegations are recorded as failures.

Before starting the runtime, resume checks the original repository identity and
Git fingerprint, and the suspended workspace fingerprint. Missing checkpoints,
removed workspaces, changed HEAD/index/non-ignored contents, or non-resumable
statuses are rejected without changing the run. Records and artifacts remain
available for inspection and explicit cleanup. Ignored build artifacts are not
part of the Git fingerprint.

Concurrent resumes are rejected by an exclusive per-run lock. SIGKILL, power loss,
and stale locks are deliberately not automatically recovered: a `running` record
or missing checkpoint is not proof that execution stopped safely. Do not remove
an execution lock until its owning process has exited.
