# FLUE-013 — Implement the delegation and revision ledger

- **Status:** Implemented
- **Difficulty:** XL
- **Depends on:** FLUE-002, FLUE-006, FLUE-009, FLUE-010, FLUE-012

## Objective

Create an auditable source of truth for delegation, patch revisions, and review evidence.

## Scope

For each delegation, record:

- role and task summary;
- parent/child relationship;
- start and completion times;
- validated result or failure;
- patch revision before and after;
- reviewer verdict and reviewed diff hash;
- malformed-result retries.

Invalidate approvals whenever a later mutation changes the patch revision.

## Acceptance criteria

- Ledger entries are persisted atomically with the run record.
- Review approval is valid only for the exact diff hash inspected.
- Any later mutation invalidates earlier approval automatically.
- Completion eligibility can be computed without trusting final model prose.
- Parallel delegation records remain correctly associated and ordered.

## Implementation

- Added an atomically persisted, validated event ledger to run records, with
  lifecycle replay and exact patch-epoch/diff-bound completion eligibility.
- Added `delegateWithLedger` for validated results, failures, and corrective
  retries, and automatic revision recording in `PatchManager.capture`.
- Added parallel ordering, persistence, stale approval, retry, and corruption
  tests. See [delegation ledger](../delegation-ledger.md) for API boundaries and
  the follow-up policy/resumption integration.
