# FLUE-006 — Implement persistent run storage

- **Status:** Proposed
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

## Acceptance criteria

- Run records survive process restart.
- No orchestration state is written into the target repository.
- Invalid or partially written records fail safely.
- Status transitions are validated.
- Records contain enough identity information for later fingerprint checks.
