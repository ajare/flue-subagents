# Behavioral evaluations (FLUE-020)

These are opt-in, real-model acceptance probes, not offline unit tests. Run only
on a trusted host: repository commands execute locally, not inside containers.
They spend model tokens and can take up to 20 minutes per scenario. The default
suite never connects to a model server.

```sh
npm ci
npm test
npm run typecheck
npm run lint
FLUE_AGENT_EVAL=1 npm run test:eval
# Select one scenario with Node's runner:
FLUE_AGENT_EVAL=1 node --test --test-name-pattern=repair tests/evals/behavior.test.ts
```

Set `FLUE_AGENT_ENDPOINT`, `FLUE_AGENT_MODEL`, and other normal configuration
variables before running. No credentials are required for the default local
endpoint; the provider currently uses a fixed `local` API key. Without the
explicit `FLUE_AGENT_EVAL=1` opt-in, all model cases are reported as skipped.
Tests run sequentially because the embedded runtime has process-global state.

## Scenarios and observable evidence

| Scenario | Required evidence |
| --- | --- |
| Trivial question | Completed, zero delegations, unchanged original |
| Independent exploration | Overlapping explorer task intervals, no mutation |
| Simple edit | No planner; implemented, validated, reviewed, published exact content; HEAD unchanged |
| Complex migration | Planner delegation; reviewed publication; independent arithmetic/API checks |
| Rejection and repair | `changes_requested`, later implementation and approval of a newer patch epoch |
| Needs input | Suspended without original changes; answer resumes the same run to reviewed publication |
| Review exhaustion | Rejection and two bounded repair attempts; blocked, no original changes |
| Requested commit | One new commit, expected content, clean index/worktree |

Simple and commit scenarios use the same objective with different explicit commit
authority. The rejection and exhaustion probes use **controlled intermediate
candidates** in their prompts to exercise otherwise unpredictable negative
paths. They are not claims about how often ordinary tasks need repair. Exhaustion
intentionally has no permitted passing implementation. A model that refuses the
exercise early instead of exercising two repairs fails that probe; this is useful
diagnostic information, not evidence that it published unsafe code.

Assertions read validated ledger events, command metadata, statuses, Git state,
and independently executed output checks. They do not inspect hidden reasoning,
require exact prose, or require one full tool-call sequence. Required partial
orders (reject before repair before fresh approval) are workflow invariants.
Model-authored tests alone are not the oracle for the complex migration.

Each scenario creates a fresh disposable Git repository and private run store.
Normal teardown removes both. Public evidence (configuration, report, ledger,
command events) is written to `.eval-results/`, or `FLUE_AGENT_EVAL_RESULTS`.
Artifacts exclude private conversations and raw command output but may still
contain repository information. Preserve the Node version, Git version, model
server/model revision and test revision alongside artifacts when comparing runs.
A hard-killed test may require manual cleanup of temporary worktrees.

## Interpreting results

Record pass/fail/skip per scenario, not only an aggregate score. Missing model
connectivity is a failure when opted in, never a silent pass. Do not retry failures
until a green result and discard the failures; use repeated fresh runs to report
variability. These probes are not a security benchmark or proof of autonomy on
arbitrary repositories. No real-model pass is claimed merely because offline
checks pass; execute and retain evidence against the actual deployment model.

`npm run test:e2e` is the deterministic complement: the production runner and real
Flue runtime execute a scripted model's tool calls in disposable repositories,
including actual validation/review commands, commit/no-commit publication,
blocked review, and malformed terminal output. Only model connectivity and
inference are replaced. Both negative cases assert unchanged original content,
HEAD, index and worktree. Existing orchestration, review, resumption and publication
suites cover budgets, stale revisions, cancellation and unsafe continuation.
