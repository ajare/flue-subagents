# FLUE-023 — Recover from output-limit-truncated sub-agent results

- **Status:** Implemented
- **Difficulty:** M
- **Depends on:** FLUE-010, FLUE-014, FLUE-019, FLUE-022

## Objective

Detect when a specialist's final structured result is truncated by the model output limit and perform one bounded, in-place compaction retry instead of reporting only a generic malformed-JSON failure.

## Bug

In run `c91e479c-0e88-4d2b-8b44-20c174058b1d`, `explorer-4` completed a broad investigation of `Layer` dimensions, indexing, construction sites, callers, and checked-arithmetic conventions. Its final model turn reached exactly 32,768 output tokens and ended with provider stop reason `length`.

The visible response began as the required explorer JSON object but stopped in the middle of an evidence string:

```text
"observation": "WorldException(World const*, message) derives from Exception :
```

The application then reported only:

```text
Invalid explorer result: $ must be valid JSON
```

The task consumed 65,743 output tokens across 26 model calls and ran for approximately 17 minutes before being discarded. The failure was presented as ordinary malformed JSON even though telemetry showed a deterministic output-limit truncation. No compacting retry was attempted in the same explorer session.

## Root cause

- Specialist results are returned as one free-form JSON text response.
- The result schemas do not impose or communicate a practical response-size budget.
- Broad prompts can encourage exhaustive excerpts and repetitive evidence.
- Provider completion usage includes reasoning tokens as well as visible result tokens, so a response can exhaust `maxOutputTokens` before the JSON closes.
- Result validation sees only incomplete text and collapses the cause to `must be valid JSON`.
- The production runtime path does not currently perform the documented in-place corrective retry described in FLUE-022.

## Proposed fix

### 1. Preserve and classify the provider stop reason

Carry the final specialist turn's stop reason through the runtime boundary. When the stop reason is `length` and the result is incomplete, classify it as `output_truncated`, not generic malformed JSON.

Persist safe diagnostics including:

- role, task ID, and durable agent name;
- configured output-token limit;
- reported output token count;
- stop reason; and
- whether the response reached structured-result validation.

Do not expose the partial model response, reasoning, or command output in public events.

### 2. Retry compactly in the same specialist session

Use the shared one-correction mechanism from FLUE-022. Send the same child conversation a corrective continuation such as:

```text
Your result was truncated at the output-token limit and is invalid. Return only
one compact JSON object matching the contract. Preserve conclusions and unique
evidence, deduplicate callers, shorten excerpts to the minimum needed, and omit
narrative already represented by evidence entries.
```

The retry must:

- retain the same task ID and `explorer-N` name;
- consume the single documented corrective attempt and shared delegation budget;
- avoid rerunning repository commands unless necessary;
- request a materially smaller result; and
- fail terminally if the compacted response is again truncated or invalid.

### 3. Give specialists an explicit result-size policy

Update specialist output contracts to require concise structured evidence:

- one evidence item per distinct fact rather than one per grep hit;
- grouped caller locations when the observation is identical;
- short excerpts centered on the relevant expression;
- no full-file, full-command, or repeated issue-body reproduction unless verbatim content is the objective;
- summaries should point to evidence rather than duplicate it; and
- target a conservative fraction of the configured output budget for the final object.

Delegation guidance should split genuinely independent exhaustive inventories into bounded tasks rather than asking one specialist for every caller plus full surrounding excerpts.

### 4. Add contract-aware size safeguards

Add configurable, role-appropriate limits for public result fields and collections. Reject overlarge but complete results with actionable validation issues that identify which field or collection must be compacted. Limits must be high enough for legitimate findings and should constrain presentation size, not silently drop evidence.

Where provider/runtime APIs expose separate reasoning and visible-output controls, reserve enough capacity for the structured result. Do not rely on increasing the global token limit as the primary fix.

### 5. Report recovery accurately

Human and JSON reporting should distinguish:

- `output_truncated` followed by a successful compacting retry;
- terminal repeated truncation; and
- syntactically malformed JSON produced without a length stop.

A recovered truncation should not appear as a failed sub-agent. Performance reporting should still count both model attempts and their tokens.

## Implementation notes

Likely touch points:

- `src/model-provider.ts` / local provider integration — retain completion stop reason where available.
- `src/orchestrator-policy.ts` — classify truncation and invoke the shared corrective flow.
- `src/result-contracts.ts` — add concise correction guidance and result-size constraints.
- `src/subagents/*.ts` — document compact output requirements.
- `src/execution-telemetry.ts` — persist safe stop-reason and truncation metadata.
- `src/reporting.ts` — expose recovered and terminal truncation states.
- `tests/result-contracts.test.ts`, orchestration-policy tests, telemetry tests, and reporting tests — exercise a mocked `length` response.

The implementation should use structured provider metadata rather than guessing truncation solely from an unmatched brace. Providers that do not expose a stop reason may retain the ordinary malformed-result path.

## Implementation

The runtime model-stream adapter retains provider stop/usage metadata and routes
length-stopped results through the existing specialist finish tool. It buffers
specialist turns so Flue's durable streamed blocks and final tool-call identities
remain consistent; replacing only the final response violates runtime invariants.
The original child conversation, task, budget, and mutation boundary remain active.
Incomplete or provider-salvaged tool arguments cannot execute repository commands.

Presentation budgets are configurable in project configuration/environment (see
`docs/configuration.md`). Prompts include the effective role-specific limits and a
quarter-output-budget target. The OpenAI-compatible provider does not expose a
portable separate visible-output reservation, so the implementation uses compact
output guidance and bounded recovery rather than raising the global token limit.

`tests/truncated-result.test.ts` covers real Flue runtime recovery, repeated
truncation, invalid correction, exhausted budget, safe reporting, retained usage,
and actionable presentation limits.

## Acceptance criteria

- A specialist response ending with stop reason `length` is classified as `output_truncated`, not merely `must be valid JSON`.
- The event records the configured limit and token count without exposing partial response content.
- One compacting continuation is sent to the same child conversation under the same task ID and agent name.
- The continuation consumes the existing single corrective attempt and one additional delegation-budget unit.
- A valid compacted result completes the original delegation and records `malformed`/truncation, `retry`, then `result`, with no delegation `failure`.
- A second truncation or malformed correction fails terminally; no third attempt occurs.
- Specialist prompts require concise, deduplicated evidence and discourage exhaustive repeated excerpts.
- Complete results that exceed application presentation limits receive actionable size-validation issues rather than silent truncation.
- Public reports distinguish recovered truncation, repeated truncation, and ordinary malformed JSON.
- Regression coverage reproduces the `explorer-4` shape: an explorer response that starts valid JSON, ends mid-string, reports exactly the configured output limit, and has stop reason `length`.
- Existing valid results and providers without stop-reason metadata continue to work unchanged.
