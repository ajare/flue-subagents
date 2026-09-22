# Prompt examples

Give `flue-agent` an engineering objective, relevant context, constraints, and a
way to check success. You generally do not need to prescribe which subagents to
use: the orchestrator chooses exploration, planning, implementation and review.
Small tasks should stay small; every mutation requires independent review.

> **Use only trusted prompts and trusted repositories.** Commands and repository
> tests run on your host. A request such as “do not modify files” expresses task
> intent, not an OS-enforced sandbox. See [security limitations](security.md).

## Before you start

Follow the [installation and configuration guide](../README.md#install-and-configure),
start your model server, and choose a trusted Git repository:

```sh
export REPO=/absolute/path/to/your/repository
git -C "$REPO" status --short
```

Prefer a clean checkout and avoid concurrent edits while a run is active. The
paths, APIs and test commands below are illustrative: replace them with ones
that exist in your project. Examples use a POSIX shell. Without `npm link`, use
`node /absolute/path/to/flue-subagents/src/cli.ts` instead of `flue-agent`.

## 1. Ask a focused repository question

```sh
flue-agent --repo "$REPO" \
  'Where is the HTTP request timeout configured, and what is its default?
   Cite the relevant file paths and symbols. Do not modify files.'
```

Use this for locating behavior, understanding configuration, or finding an entry
point. A narrow question should not need implementation or a separate plan.
Ask for evidence so you can verify the answer rather than relying on a summary.

## 2. Explore independent parts of a codebase

```sh
flue-agent --repo "$REPO" \
  'Investigate authentication and background-job processing independently.
   For each, identify entry points, data flow, existing tests, and major failure
   modes. Then explain where the two systems interact. Cite concrete paths and
   symbols. This is an investigation only; do not modify files.'
```

This gives the orchestrator independent questions that may benefit from parallel
explorers. Parallel delegation is a strategy choice, not a guarantee for every
prompt. Keep dependent follow-up analysis separate from independent discovery.

## 3. Make a small documentation change

```sh
flue-agent --repo "$REPO" \
  'Update docs/setup.md to explain that Node 22.19 or newer is required.
   Include a node --version check. Keep the rest of the setup instructions
   unchanged, and verify that the documented installation command still matches
   package.json. Do not commit.'
```

A bounded edit normally does not need a separate planner. The agent still needs
to validate and independently review the final change before publication.
Approved changes appear in your original checkout without changing HEAD.

```sh
git -C "$REPO" diff --stat
git -C "$REPO" diff
```

## 4. Fix a bug with a concrete reproducer

Use stdin for longer prompts. A quoted heredoc prevents the shell from expanding
backticks, dollar signs, or substitutions in the prompt:

```sh
flue-agent --repo "$REPO" <<'PROMPT'
Fix parseDuration in src/duration.ts.

Observed behavior: parseDuration("0ms") throws an invalid-duration error.
Expected behavior: it returns 0. Negative durations must remain invalid.
Reproducer: the existing duration test suite fails when this case is added.

Add a regression test that demonstrates the bug, make the smallest appropriate
fix, and run npm test. Preserve existing behavior for seconds and minutes.
Do not add dependencies or change the public function signature. Do not commit.
PROMPT
```

Include the actual error, minimal input, expected output, and relevant command
when you have them. If you do not know the cause, describe symptoms rather than
asserting a diagnosis. The agent can investigate before choosing a fix.

## 5. Implement a feature with acceptance criteria

```sh
flue-agent --repo "$REPO" <<'PROMPT'
Add a --dry-run option to the import CLI.

Acceptance criteria:
- Parse and validate the input exactly as a normal import would.
- Print how many records would be imported.
- Do not write to the database or enqueue jobs in dry-run mode.
- Invalid input must still produce a nonzero exit code.
- Preserve existing behavior when --dry-run is absent.

Follow the existing CLI option conventions. Add tests for valid input, invalid
input, and absence of database/job side effects. Update the CLI usage docs.
Run npm test and npm run typecheck. Do not add dependencies. Do not commit.
PROMPT
```

Define observable behavior and boundaries, not every implementation step. If
validation needs a database or service, explain how to start a disposable test
instance—or explicitly identify what cannot be validated. Never point an agent
at production data to test a feature.

## 6. Request a cross-cutting refactor

```sh
flue-agent --repo "$REPO" <<'PROMPT'
Replace the duplicated retry loops in the HTTP client and job worker with a
shared retry utility.

Preserve each caller's current attempt count, delay policy, error propagation,
and cancellation behavior. Do not retry operations that currently run once.
Keep the public APIs stable and avoid new dependencies.

Assess both callers and their tests before changing them. Produce a plan that
identifies compatibility risks, then implement it with regression coverage for
both callers. Run npm test and npm run typecheck. Document any validation gaps.
Do not commit.
PROMPT
```

This is the kind of task where planning and focused exploration are useful.
Specify compatibility requirements explicitly. “Clean up the retries” alone
leaves too much uncertainty about permitted behavior changes.

## 7. Review existing work without requesting repairs

For changes already present in your checkout, explicitly allow the dirty baseline:

```sh
flue-agent --repo "$REPO" --allow-dirty \
  'Review the current staged and unstaged changes relative to HEAD.
   Focus on correctness, compatibility, and missing regression coverage.
   Report findings with file paths, severity, and concrete reproducers where
   possible. Do not repair findings or intentionally modify source files.
   Do not commit.'
```

`--allow-dirty` permits and fingerprints existing local changes; it is not
permission to overwrite unrelated work. Do not change the checkout during the
run. For review of committed code, omit the flag and name the commit range or
specific subsystem in the prompt.

Review intent does not make shell commands safe against an untrusted repository.
Validation tools may produce build artifacts; use trusted projects only.

## 8. Request a commit explicitly

The default is publication without a commit. For an approved change that should
also be committed, prefer the explicit flag:

```sh
flue-agent --repo "$REPO" --commit \
  'Fix the zero-duration parsing bug and add a regression test.
   Run npm test. Commit with message "Fix zero-duration parsing".'
```

Commit authorization comes from `--commit` or an explicit commit instruction in
the original prompt. The flag authorizes a commit even if the prompt says not
to commit, so do not combine contradictory instructions. Hooks run normally.

```sh
git -C "$REPO" log -1 --oneline
git -C "$REPO" status --short
```

Check the report: requesting a commit does not guarantee success. A hook or
finalization failure may leave approved published changes without a commit.
See [publication](patch-publication.md) for the publication boundary.

## 9. Handle a decision the repository cannot answer

```sh
flue-agent --repo "$REPO" \
  'Update the CSV export to the new public format. The product decision about
   retaining legacy column names is not documented here. Ask me whether legacy
   clients must remain compatible before making a breaking change.'
```

If the run returns `needs_input` (exit code 2), use the printed run ID:

```sh
flue-agent inspect <run-id>
flue-agent resume <run-id> \
  'Legacy clients must remain compatible. Preserve the default column names;
   expose the new names only through an explicit format-version option.'
```

Replace `<run-id>` with the actual ID; do not paste the angle-bracket placeholder
into your shell. Resume continues the saved objective, conversation, workspace
and review history. It does not infer new commit authority from the answer.
Do not edit the original checkout or retained workspace while suspended: changed
fingerprints cause resumption to be rejected. See [resumption](resumption.md).

## 10. Capture structured results for automation

```sh
if flue-agent --repo "$REPO" --json \
  'Fix the zero-duration parsing bug, add regression coverage, and run npm test.
   Do not commit.' > /tmp/flue-run.ndjson; then
  echo 'Completed; inspect the final report and published diff.'
else
  status=$?
  printf 'Run did not complete successfully (exit %s).\n' "$status"
fi
```

Use an output path **outside the target repository**: shell redirection creates
the file before preflight and could otherwise make the checkout dirty. JSON mode
emits NDJSON events and a final report, not one JSON document. Pre-run failures
emit an error instead. The security warning goes to stderr.

Exit codes are 0 completed, 1 failed, 2 needs input, 3 blocked, and 130 interrupted.
Do not treat a blocked run as success or automatically retry it indefinitely.
Use `flue-agent inspect <run-id> --json` to inspect the persisted report. See
[reporting](reporting.md) for the output contract and management commands.

## A reusable prompt template

```text
Objective: <the user-visible outcome>
Context: <relevant paths, symptoms, examples, or known decisions>
Acceptance criteria:
- <observable behavior>
- <edge cases and compatibility requirements>
Constraints: <out-of-scope work, dependency/API restrictions>
Validation: <commands and required services; known unavailable checks>
Commit policy: Do not commit.
```

Avoid broad prompts such as “improve everything,” unsupported claims such as
“all tests passed” when they have not run, and requests to ignore reviewer
findings or bypass limits. If blocked, inspect the findings, narrow the objective
or resolve the missing prerequisite, then start a new run. Only `needs_input`
and safely checkpointed `interrupted` runs support continuation.
