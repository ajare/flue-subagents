# FLUE-021 — Preflight delegation briefings before starting sub-agents

- **Status:** Implemented
- **Difficulty:** M
- **Depends on:** FLUE-013, FLUE-015, FLUE-019

## Objective

Reject an invalid specialist briefing as an orchestrator tool-input error before it is recorded and reported as a failed sub-agent execution.

## Bug

Run `c91e479c-0e88-4d2b-8b44-20c174058b1d` created `reviewer-1` for a reviewer prompt that contained `Role task:`, `Plan:`, `Diff:`, `Validation report:`, and `Known limitations and unresolved issues:`, but omitted the required `Objective:` heading.

The application correctly detected the invalid briefing and returned:

```text
Incomplete reviewer briefing; missing sections: Objective
```

However, validation happened after the task had been named, started in the delegation ledger, and counted against the delegation limit. Public execution telemetry consequently reported `reviewer-1` as a failed sub-agent with zero model calls and no failure reason. Determining the cause required inspecting the private Flue conversation database. The orchestrator corrected the prompt and launched `reviewer-2`, but the original reviewer failure remained an unwaivable failed delegation.

This is misleading and can unnecessarily poison a run: no reviewer model was invoked, so no sub-agent actually failed. The orchestrator submitted invalid tool input and the application rejected it during preflight.

## Root cause

`OrchestrationPolicyController` currently handles a task in this order:

1. `task_start` observation allocates an agent name and telemetry start span.
2. `execute()` captures the patch and appends a delegation `start` ledger action.
3. The delegation budget is consumed.
4. `assertSelfContainedBriefing()` validates the prompt.
5. Its `OrchestrationDefectError` is caught and persisted as a delegation `failure`.
6. Runtime telemetry records a failed `subagent_end`, but omits the error reason.

The validation is therefore semantically a preflight check but operationally occurs after delegation execution has begun.

## Proposed fix

### 1. Add a preflight phase

Validate the role and call `assertSelfContainedBriefing()` before all execution side effects:

- before allocating a durable `explorer-N`, `planner-N`, `implementer-N`, or `reviewer-N` name;
- before appending a delegation `start` action;
- before consuming delegation or repair-cycle budgets;
- before entering concurrency/writer gates;
- before patch capture; and
- before invoking the specialist model.

A corrected retry should therefore receive the next real agent name. In the incident above, the valid retry would be `reviewer-1`, not `reviewer-2`.

### 2. Distinguish rejection from execution failure

Represent an invalid role or briefing as a rejected orchestrator task-tool call, not a failed delegation. Keep it auditable using a dedicated event such as:

```json
{
  "event": "delegation_rejected",
  "role": "reviewer",
  "reasonCode": "incomplete_briefing",
  "missingSections": ["Objective"]
}
```

The rejected call must not appear in replayed delegation state and must not trigger the rule that reviewer failures are unwaivable. The private conversation can continue to retain the complete tool error.

### 3. Expose a safe failure reason

Human and JSON event output should include a sanitized reason for preflight rejection. For genuine sub-agent failures, telemetry/reporting should expose an application-owned reason code and concise message when available, without publishing model output, command output, prompts, stack traces, or hidden reasoning.

For this case, `inspect --json` should make the cause directly visible as `incomplete_briefing` with `missingSections: ["Objective"]`.

### 4. Preserve fail-closed behavior

Do not weaken the briefing contract and do not infer or synthesize missing sections. The orchestrator must receive the validation error and explicitly submit a corrected prompt. Invalid prompts must never reach a specialist model.

## Implementation notes

Likely touch points:

- `src/orchestrator-policy.ts` — separate prompt preflight from delegation execution and move validation ahead of durable start/budget effects.
- `src/agent-names.ts` — allocate names only for briefings that pass preflight.
- `src/execution-telemetry.ts` — distinguish rejected task calls from started sub-agent spans and retain safe reason metadata.
- `src/reporting.ts` and console event projection — render the rejection reason in human and JSON modes.
- `src/delegation-ledger.ts` — either add a non-delegation audit action or ensure rejected calls remain outside replayed delegation state.
- `tests/orchestrator-policy.test.ts`, `tests/execution-telemetry.test.ts`, and `tests/reporting.test.ts` — regression coverage.

The implementation may use a dedicated rejection audit file/event instead of extending the delegation ledger, provided inspection remains possible and replay invariants continue to treat the call as preflight rather than delegation execution.

## Implementation

- Shared, side-effect-free preflight validates role and required sections before policy execution and telemetry identity allocation.
- Rejections are audited as `delegation_rejected` events in `execution-telemetry.jsonl`, outside delegation ledger replay. Live events and reconstructed report `delegationDiagnostics` expose safe codes and missing headings.
- Genuine runtime failures retain failed spans and emit a content-free `specialist_execution_failed` diagnostic; runtime error/result text is not published.
- Regression tests cover corrected reviewer numbering, rejected repair attempts after review, unchanged budgets/gates/patch capture, unauthorized roles, and human/JSON inspection.

## Acceptance criteria

- A reviewer prompt missing `Objective:` is rejected with reason code `incomplete_briefing` and `missingSections: ["Objective"]`.
- The specialist model and `next()` execution callback are not invoked.
- No delegation start, result, malformed-result, or failure is added to replayed ledger state.
- Delegation and repair-cycle budgets are unchanged.
- No concurrency or writer slot is acquired and no patch capture occurs.
- The rejected call does not allocate a durable specialist name; a subsequent valid reviewer is named `reviewer-1`.
- Public human and JSON output identify the rejection and its safe reason without exposing the full prompt or private model data.
- A rejected reviewer briefing does not create an unwaivable reviewer failure or prevent an otherwise valid run from completing.
- Valid briefings and genuine specialist execution failures retain their existing fail-closed behavior.
- Unit tests cover missing common headings, missing reviewer-only headings, unauthorized roles, corrected retries, budget accounting, telemetry, and reconstructed `inspect` output.
