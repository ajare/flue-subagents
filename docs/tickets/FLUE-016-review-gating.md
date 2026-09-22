# FLUE-016 — Implement review, repair, and completion gating

- **Status:** Proposed
- **Difficulty:** XL
- **Depends on:** FLUE-009, FLUE-013, FLUE-014, FLUE-015

## Objective

Prevent publication and successful completion until the final patch has independent, revision-specific review evidence.

## Scope

- Require review for every mutation run.
- Allow parallel reviewers for separate concerns.
- Aggregate verdicts conservatively.
- Snapshot before review and detect reviewer-induced source mutation.
- Bind every verdict to the reviewed diff hash.
- Trigger implementer repair followed by fresh review.
- Enforce the two-repair-cycle limit.
- Distinguish acceptable limitations from inability to verify central behavior.

## Acceptance criteria

- No mutation run reports `completed` without valid review of its final revision.
- Any substantiated `changes_requested` finding blocks approval until repaired.
- Reviewer mutation cannot be silently incorporated.
- Missing optional validation can produce `approved_with_limitations` with explicit warnings.
- Missing validation of central behavior produces `blocked`.
- Exhausted repair cycles produce `blocked` with unresolved findings.
