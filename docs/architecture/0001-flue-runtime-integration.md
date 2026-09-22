# ADR 0001: Flue runtime integration

- **Status:** Accepted
- **Ticket:** FLUE-002

## Context

The agent needs programmatic orchestration, concurrent specialist delegation, observable delegation lifecycle events, cancellation, conversation continuation, structured role results, and review evidence tied to an exact patch revision.

The executable probe at `src/prototypes/flue-integration.ts` exercises Flue 2.0.3 with Pi's in-memory faux provider. Run it with:

```sh
npm run probe:flue
```

The probe requires no model server. It fails with an assertion error when an integration assumption is violated and prints a JSON report otherwise.

## Observations

The probe established the following behavior:

1. `start()` creates an embedded Node runtime and `init()` returns a conversation handle. `dispatch()` admits work and returns a receipt; `read()` resolves the settled `AgentReply`.
2. Two `task` calls emitted by one model turn overlap. Both child response factories were active simultaneously (`maximumConcurrentChildren: 2`). Each delegation emitted correlated `task_start` and `task` observations with a `taskId`, child agent name, prompt, result, duration, parent session, and child session.
3. Runtime observations also expose submission, operation, model-turn, tool-call, and settlement boundaries. `submissionId`, `taskId`, `toolCallId`, `conversationId`, and session fields provide enough correlation data to populate an operational delegation trace.
4. `abort()` durably requests cancellation of active and queued work. The cancelled submission's `read()` rejected with `AgentRunError` and outcome `aborted`.
5. An aborted submission is terminal; it is not resumed. A new dispatch to the same handle continued the existing conversation with the same instance UID and settled normally.
6. Cancelling `read()` with an `AbortSignal` only detaches that reader. It does not cancel agent work; use `abort()` for that.
7. Root replies are returned as `AgentReply` (`text`, named `data` parts, optional `metadata`, `uid`, and `submissionId`). A framework subagent's result is free-form final text returned by the `task` call and exposed on the terminal `task` observation.

## Decision

Use Flue's embedded Node runtime as the execution engine:

- bootstrap with `start()`;
- address an orchestration conversation with a stable run ID through `init()`;
- split admission from waiting by persisting the `dispatch()` receipt before calling `read()`;
- define specialist capabilities with `defineSubagent()` and mount them with `useSubagent()`;
- allow independent tasks to be emitted in one tool-call batch for concurrency;
- subscribe once with `observe()` for live operational events and correlation;
- use `handle.abort()` for durable cancellation and a new dispatch on the same conversation for continuation;
- use a durable SQLite adapter in the production CLI so receipts can be read again after process restart.

The application run store and delegation ledger remain authoritative. Flue's event stream enriches that ledger but does not replace it.

## Framework limitations and alternatives

### Runtime observations are live-only

`observe()` has no replay and subscribers are synchronous, best-effort consumers. A process crash can therefore lose events even though Flue's canonical conversation survives.

**Alternative:** persist application-owned delegation records at orchestration boundaries. Persist the dispatch receipt before waiting, assign an application delegation ID, include it in delegated prompts, and reconcile terminal state from settled calls. Use observations for task/session correlation, timing, usage, and diagnostics, not as the sole durable ledger.

### Framework task results are text

`defineSubagent()` does not attach a schema to the final task answer.

**Alternative:** require versioned JSON in specialist prompts, validate it with Valibot at the application boundary, and permit the single corrective retry specified by FLUE-010. Where orchestration is performed inside a harness, `harness.prompt(..., { result: schema })` can enforce a structured aggregate result.

### Cancellation does not resume the aborted submission

`abort()` settles current and queued submissions as aborted. Flue does not restart that same submission.

**Alternative:** preserve the application run/workspace, then dispatch a continuation message to the same conversation after compatibility checks. Persisted SQLite state and the instance UID protect conversation identity. Reattaching `read()` to an admitted, non-aborted receipt after a process restart is supported; that is distinct from reviving an aborted submission.

### Review events have no patch-revision semantics

Flue correlates a review delegation by task/session identifiers but does not know Git diff identity.

**Alternative:** compute the patch revision and diff hash before review, include both in the reviewer request and validated result, and persist them with the application delegation record. Every repository mutation creates a new revision and invalidates approvals attached to older hashes.

### Model-driven delegation is not an application transaction

A model can invoke the built-in `task` tool, but application storage cannot atomically commit with Flue's internal task record.

**Alternative:** completion eligibility must be computed from the application ledger. For operations requiring stronger control, expose an application-owned durable harness tool that records intent/result around a required delegate call, using idempotent keys and reconciliation after interruption.

## Consequences

- Flue supplies the required runtime, parallel task execution, cancellation, continuation, and rich correlation events.
- The production design must add durable application records rather than treating telemetry as durable state.
- Structured contracts and Git revision binding remain application concerns and are feasible without patching Flue.
- Tests can use Pi's faux provider and the same embedded runtime without a local inference server.
