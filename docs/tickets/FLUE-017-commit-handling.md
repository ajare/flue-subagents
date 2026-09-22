# FLUE-017 — Implement explicit commit handling

- **Status:** Proposed
- **Difficulty:** M
- **Depends on:** FLUE-009, FLUE-016

## Objective

Create a commit only when explicitly requested, after the exact approved patch has been published.

## Scope

- Default to leaving approved changes uncommitted.
- Recognize an explicit commit request in the prompt.
- Optionally support `--commit` as an unambiguous request.
- Apply the approved patch before committing in the original checkout.
- Create at most one final commit.
- Generate a commit message unless the prompt supplies one.
- Run commit hooks normally.
- Revalidate hook-modified output or return `blocked`.

## Acceptance criteria

- Prompts without an explicit commit request never create commits.
- The commit contains only the approved files and patch.
- Hook rejection is reported without bypassing hooks.
- Hook mutation cannot create an unreviewed successful result.
- A successful commit leaves the repository on the expected new HEAD.
