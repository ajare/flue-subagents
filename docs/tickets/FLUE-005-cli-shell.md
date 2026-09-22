# FLUE-005 — Build the `flue-agent` CLI shell

- **Status:** Proposed
- **Difficulty:** M
- **Depends on:** FLUE-003, FLUE-004

## Objective

Provide the primary one-shot command-line interface for submitting an engineering objective.

## Scope

- Register a package binary named `flue-agent`.
- Support `--repo`, defaulting to the current directory.
- Accept a prompt as a positional argument.
- When no argument is supplied, read the complete prompt from stdin.
- Reject missing or empty prompts.
- Resolve the repository to a canonical absolute path.
- Add help, version, and initial top-level error handling.

## Acceptance criteria

- Argument and piped-stdin invocations create equivalent execution requests.
- Empty stdin and empty prompt arguments fail clearly.
- Repository paths are canonicalized before further processing.
- Help documents trusted-local operation and both prompt input forms.
- Initial failures return non-zero exit codes.
