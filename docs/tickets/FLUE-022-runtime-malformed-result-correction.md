# FLUE-022 — Correct malformed runtime sub-agent results in place

- **Status:** Implemented
- **Difficulty:** L
- **Depends on:** FLUE-010, FLUE-013, FLUE-015, FLUE-021

## Objective

Make the production Flue task path honor the documented single corrective retry for malformed specialist results, without discarding valid work or creating a second failed delegation.

## Bug

In run `c91e479c-0e88-4d2b-8b44-20c174058b1d`, `reviewer-2` successfully retrieved GitHub issue #184, checked the repository, and returned a substantial reviewer JSON object. Its final object did not satisfy the reviewer result contract:

```text
$.verdict: Invalid key: Expected "verdict" but received undefined
$.findings[0].path: Invalid type: Expected string but received null
$.findings[0].line: Invalid type: Expected number but received null
```

The required `verdict` was absent. The optional `path` and `line` fields should have been omitted when unavailable, but were explicitly `null`.

The application marked the whole delegation malformed and failed. The orchestrator then launched `reviewer-3`, which repeated the work and returned a valid result. This wasted model tokens and commands, lost an otherwise useful result, incremented agent numbering, and left an unwaivable failed reviewer in the ledger.

## Expected behavior

FLUE-010 and `delegateWithValidatedResult()` specify one corrective retry for malformed specialist output. Validation issues should be returned to the same specialist session so it can repair only the result object while retaining its investigation context. A successful correction should complete the original delegation; only a second malformed result should fail it.

The production `OrchestrationPolicyController` task interceptor currently validates once with `validateSubagentResult()` and immediately records failure. It does not use the corrective flow implemented by `delegateWithValidatedResult()`, so production behavior differs from the documented and unit-tested result-contract behavior.

## Proposed fix

### 1. Unify runtime and programmatic correction semantics

Extract or reuse one application-owned result-correction state machine for both `delegateWithLedger()` and runtime task interception:

1. Validate the specialist's first result.
2. On `ResultValidationError`, append one `malformed` ledger action containing structured issues.
3. Consume one additional delegation attempt from the shared budget.
4. Send the exact validation issues and the original output contract to the same child conversation as a corrective continuation.
5. Append a `retry` ledger action.
6. Validate the corrected result.
7. Append `result` and complete the original delegation when valid; append `failure` only if the correction is still malformed or execution fails.

The correction must retain the same task ID and durable agent name. It must not launch another `reviewer-N` merely to repair formatting.

If Flue cannot currently continue a child task conversation, add a role-specific structured-result tool/finish hook analogous to `useStructuredResult()` for the orchestrator. Schema-invalid tool arguments should be rejected inside the specialist session, allowing one bounded corrective continuation before the task settles.

### 2. Canonicalize harmless optional nulls

Before strict role-schema validation, canonicalize explicit `null` only for fields whose contract says to omit them when unavailable, such as reviewer finding `path` and `line`. This should match the existing explorer presentation adapter behavior.

Do not infer required semantic fields. In particular, the application must never invent a reviewer `verdict`, finding severity, validation result, summary, or limitation. Missing `verdict` must still trigger the bounded correction flow.

### 3. Preserve budgets and fail-closed behavior

- The first response and its one correction each consume a delegation attempt, as documented.
- No third malformed-result attempt is allowed.
- A second malformed result remains a terminal delegation failure.
- Review approval is recorded only after the corrected object passes the complete reviewer schema and existing review gates.
- Source mutation checks apply across the entire original task and corrective continuation.

### 4. Improve public diagnostics

Expose a safe malformed-result reason in task events and reconstructed inspection output: role, task ID, retry number, and schema issue paths/messages. Do not expose raw model output, prompts, hidden reasoning, or command output.

A corrected malformed result should be reported as a recovered contract error, not as a failed sub-agent. A terminal second malformed result should clearly report both attempts.

## Implementation notes

Likely touch points:

- `src/orchestrator-policy.ts` — replace one-shot runtime validation with the shared correction flow.
- `src/result-contracts.ts` and `src/delegation.ts` — expose a reusable correction state machine without duplicating budget or ledger behavior.
- `src/agents/structured-result.ts` or a new specialist equivalent — support validated role-specific result submission and bounded continuation if needed.
- `src/subagents/explorer-result.ts` or a shared normalizer — canonicalize permitted optional `null` values consistently across roles.
- `src/delegation-ledger.ts` — retain malformed and retry actions under one delegation.
- `src/execution-telemetry.ts` and `src/reporting.ts` — report recovered versus terminal contract failures.
- Production-path tests, not only direct `delegateWithValidatedResult()` tests.

## Acceptance criteria

- A reviewer result missing `verdict` receives one corrective continuation containing the exact validation issue.
- The correction runs in the same task/conversation and retains the same `reviewer-N` name.
- A valid correction records `malformed`, then `retry`, then `result`; it does not record `failure`.
- A valid correction is accepted by review gating exactly as a valid first response would be.
- A second malformed response records its issues and a terminal failure, with no third attempt.
- Each model attempt consumes the documented shared delegation budget.
- Explicit `null` for optional reviewer finding `path` and `line` is normalized to omission; missing required fields are never inferred.
- Patch/source mutation checks span both attempts.
- Public events and `inspect --json` distinguish a recovered malformed result from a terminal sub-agent failure and include safe schema diagnostics.
- Regression coverage exercises the real runtime interceptor path with the exact incident shape: missing `verdict`, `path: null`, and `line: null`.
- Existing valid first-attempt results remain unchanged, and malformed explorer, planner, implementer, and reviewer results all follow the same one-correction limit.
