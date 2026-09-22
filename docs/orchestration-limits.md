# Orchestration limits

`OrchestrationLimits` is the shared, per-run policy object for autonomous work.
It is configured from the immutable configuration stored in the run record.

- `readOnly` / `runReadOnly()` use a fair, abort-aware gate with the configured
  read-only concurrency.
- `implementers` / `runImplementer()` use a separate gate. Configuration
  validation fixes this limit at one, so active implementation is serialized.
- `delegationBudget` is passed to validated delegation. Initial calls and the
  one malformed-output correction both consume it. `consumeDelegation()` is
  available to dispatchers that perform validation elsewhere.
- `consumeRepairCycle()` counts repairs after the initial implementation.
- `checkRuntime()` and `runWithinDeadline()` enforce runtime measured from the
  run's persisted creation time. The deadline abort signal should be forwarded
  to delegated work and commands.

Delegation and repair counts can be initialized with already-recorded values
when reconstructing policy state. Counts are application-owned rather than
model-reported. `OrchestrationPolicyController` applies the same budget and
role gates around every model-driven Flue task, so calling the built-in task
tool does not bypass these limits.

## Outcomes

`OrchestrationLimitError` has `outcome: "blocked"` and identifies the exhausted
`limitName`, configured `limit`, and observed `used` value. `blockOnLimit()`
atomically transitions a running record to `blocked` for this error while
leaving infrastructure and programming errors untouched.

Workspace enforcement remains in `WorkspaceManager`: it measures logical bytes,
latches overflow, and blocks the run. `workspaceLocal` caps every command at
`commandTimeoutMs`, monitors workspace size during commands, and records the
outcome in the command audit log. The CLI wraps the complete model execution in
the run deadline and requests a durable Flue abort when it expires.
