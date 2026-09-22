# FLUE-006 — Implement persistent run storage

- **Status:** Implemented
- **Difficulty:** L
- **Depends on:** FLUE-003, FLUE-005

## Objective

Persist enough state outside target repositories to inspect, resume, and clean up autonomous runs safely.

## Scope

- Generate stable run IDs.
- Store data in a platform-appropriate user data directory.
- Persist status, effective configuration, repository identity, timestamps, and Flue conversation ID.
- Support `completed`, `needs_input`, `blocked`, `failed`, and `interrupted` states.
- Record retained workspace and audit-log locations.
- Make state updates atomic and recoverable.

## Implementation

`src/run-storage.ts` provides versioned, validated JSON run records beneath the
platform user-data directory (or `FLUE_AGENT_DATA_DIR`). Records include the
effective configuration, canonical repository path and filesystem identity,
conversation ID, timestamps, and retained artifact locations. Writes use a
same-directory temporary file, file synchronization, and atomic rename.

The CLI execution path creates a record before runtime startup and marks it
`completed` or `failed`. Transition rules also cover resumable `needs_input` and
`interrupted` states. Storage rooted inside the target repository is refused.

## Acceptance criteria

- Run records survive process restart.
- No orchestration state is written into the target repository.
- Invalid or partially written records fail safely.
- Status transitions are validated.
- Records contain enough identity information for later fingerprint checks.
