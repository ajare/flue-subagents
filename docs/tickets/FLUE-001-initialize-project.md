# FLUE-001 — Initialize and baseline the project

- **Status:** Proposed
- **Difficulty:** S
- **Depends on:** None

## Objective

Create a reproducible, version-controlled baseline suitable for implementing and testing the autonomous agent.

## Scope

- Initialize the directory as a Git repository and create an initial baseline commit.
- Configure TypeScript and ES modules, including `"type": "module"`.
- Add build, type-check, test, lint, and formatting scripts.
- Add ignores for Flue state, temporary workspaces, and generated output.
- Replace the placeholder `npm test` command.

## Acceptance criteria

- The working tree is clean after the baseline commit.
- A fresh dependency installation succeeds.
- Build and type-check commands succeed.
- The configured empty test suite succeeds.
- Generated runtime state is excluded from Git.
