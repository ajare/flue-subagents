# Temporary workspaces

Each CLI execution creates a detached Git worktree at
`<data-directory>/runs/<run-id>/workspace`, outside the original checkout. Its
path is persisted before provisioning so failed setup can be inspected. The
orchestrator and its inherited subagent sandbox use this directory, not the
original checkout. No branch is created and no changes are published by this
lifecycle layer.

With `--allow-dirty`, staged and unstaged binary patches are applied separately
and non-ignored untracked files are copied (including executable modes and
symlinks). Ignored dependencies/build artifacts are not copied. The original
fingerprint is rechecked before and after provisioning, and the copied index
and working-tree fingerprints must match before agents start. A state that
cannot be reproduced exactly fails closed.

## Size limit

`workspaceLimitBytes` counts logical file/symlink bytes recursively, including
ignored output and the worktree's `.git` pointer, but not the shared Git object
database. Symlink targets are not followed. Checks run after provisioning,
before/after sandbox mutations and commands, during commands (every 250ms),
and before successful completion. Exceeding the limit durably marks the run
`blocked`; the in-process violation stays latched even if files are removed.
A running command is aborted when monitoring detects an overrun.

This is a measured limit, not a filesystem quota: a write or command can
briefly exceed it between checks. Publication must call `checkLimit` before
applying any changes; see [patch publication](patch-publication.md).

## Retention and cleanup

- Failed, blocked, interrupted, and `needs_input` workspaces expire after the
  run's snapshotted `retentionMs`, measured from its stopped-state timestamp.
- Zero retention deletes stopped unsuccessful workspaces immediately.
- A startup sweep removes expired workspaces; there is no background daemon.
- Running workspaces are never swept. Crash detection/cancellation is deferred
  to FLUE-018; a killed process may leave a record marked `running`.
- Completed does **not** mean published. Completed workspaces are retained
  until publication is confirmed through `WorkspaceManager.afterPublication`.
  CLI completion records patch revisions but retains the worktree until explicit
  revision/manifest approval and publication; model output alone is not approval.
- Cleanup removes only the run's owned, registered worktree, then clears its
  recorded path. Repeated cleanup is safe, including recovery after Git removal
  succeeded but the record update did not. It never globally prunes worktrees.

## Trust boundary

Ordinary sandbox file APIs reject paths outside the workspace, `.git` access,
and symlink escapes. Commands default to the workspace, inherit the restricted
agent environment, and use the configured command timeout.

This is **trusted-local operation**, not OS isolation. Arbitrary shell commands
can still access absolute host paths, follow repository symlinks, or use the
shared Git metadata. Worktrees prevent ordinary agent edits from changing the
original checkout, but are not a security boundary for hostile prompts, code,
or commands. Use an OS/container sandbox for untrusted execution.
