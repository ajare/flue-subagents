# FLUE-009 — Implement patch revision and publication

- **Status:** Proposed
- **Difficulty:** XL
- **Depends on:** FLUE-008

## Objective

Track workspace mutations precisely and transfer only the final approved change into the original checkout.

## Scope

- Calculate stable diff and patch hashes after mutation.
- Represent each mutation as a new patch revision.
- Distinguish intended new files from generated artifacts.
- Respect `.gitignore` while requiring an explicit approved-new-file manifest.
- Recheck the original repository fingerprint before publication.
- Transfer only approved modifications and approved new files.
- Detect conflicts and concurrent repository changes.
- Make publication transactional or safely reversible.

## Acceptance criteria

- Equal repository changes produce equal revision hashes.
- Arbitrary untracked workspace files are never published.
- Publication refuses a changed original repository.
- A failed publication leaves the original checkout unchanged or safely restored.
- Published content exactly matches the approved patch revision and file manifest.
