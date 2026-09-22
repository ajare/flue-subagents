# Patch revisions and publication

`PatchManager` stores `patches/baseline.json`, numbered immutable revision files,
`latest.json`, and a publication receipt under the run directory. Initialize it
immediately after workspace creation, before any agent edits. The CLI captures
revisions after sandbox mutations/commands (including failed commands), and at
completion. Commands are mutation boundaries, not individual filesystem writes.

Revisions use SHA-256 over canonical structured data, with sorted paths and a
sorted, deduplicated new-file manifest. `diffHash` covers before/after raw bytes,
file type and permission modes; `patchHash` additionally covers the manifest.
`revisionHash` binds that patch to the observed non-ignored workspace contents.
Sequence numbers are not hashed: returning to equal content produces equal hashes
but a new sequence number. No-op captures reuse the latest revision. Binary files,
symlinks, executable modes and deletions are supported without Git filters,
external diff drivers, or newline conversion. The original index is never changed.

## Explicit approval API

```ts
const patches = new PatchManager(store);
await patches.initialize(runId, preflight); // once, before mutations
// After implementation and with writers stopped:
const revision = await patches.capture(runId, ['src/intended-new-file.ts']);
// Review revision.changes and revision.approvedNewFiles externally.
await workspaces.finish(runId, 'completed');
await patches.publish(runId, revision.revisionHash);
```

Tracked paths from the starting index are eligible modifications. All other paths
require an explicit manifest, even if an agent ran `git add`. Ignored or missing
manifest entries are rejected. Pre-existing untracked user files also require a
manifest to modify them. Other untracked files are recorded in the workspace hash
but never transferred. Ignored generated files are not revision content.

A supplied revision hash alone is **not** approval: publication also requires
current, independent ledger review evidence from every reviewer of that revision.
The CLI gates completion on review and records revisions with an empty new-file
manifest. A successfully reviewed mutation run publishes its approved revision.
It leaves that publication uncommitted unless the original prompt directly asks
for a commit or `--commit` is supplied. See [review gating](review-gating.md).

## Safety and recovery

Publication requires a completed run, checks the workspace size limit, recalculates
the exact latest approved revision, and rechecks the original preflight fingerprint
and raw starting contents. Existing ignored files cannot be overwritten by new-file
publication. Unsafe paths, symlink parents, special files, and file/directory
replacement conflicts fail closed. Leaf symlinks are copied, never followed.

A per-checkout `flue-publication.lock` directory excludes cooperating publishers.
Each destination is checked before replacement; all resulting contents and the
original HEAD/branch/index are checked afterwards. Checkout writes use per-file
atomic replacement. An undo journal is persisted before writes, and ordinary
failures restore original files, modes, symlinks and newly created directories.
The workspace is removed only after successful publication.

Commit creation uses an isolated temporary index built from the starting HEAD,
so only approved paths enter the commit and unrelated user staging is preserved.
Git hooks run normally. The resulting tree, unchanged reviewed source, parent,
and HEAD are revalidated; rejection or mutation blocks completion and restores
the prior HEAD. An approved path containing pre-existing dirty content is not
committed because that would incorporate content outside the approved delta.

After process interruption, stop all writers, verify no publisher is still active,
remove a stale `flue-publication.lock` if present, then call
`patches.recover(runId)` to undo using `publication-undo.json`. If a destination
matches neither its before nor after image, recovery refuses to overwrite it and
retains the journal for manual reconciliation. Recovery is explicit, not a startup
side effect. A crash after receipt creation but before journal removal can also be
undone. A crash during an atomic replacement may leave a `.flue-*.tmp`/`.flue-*`
temporary file requiring inspection/removal. Power-loss durability is not promised.

This is trusted-local optimistic concurrency, not a filesystem transaction or an
OS sandbox. Stop agents/background commands before approval/publication. External
editors do not honor our lock; detected concurrent edits are refused, but arbitrary
writers racing individual filesystem operations cannot be made atomic. Run storage
and approval calls must be trusted. Revision images are full-content snapshots, so
storage grows with revision count; compaction is not implemented.
