# Flue Subagents Tickets

## Difficulty scale

- **S** — straightforward, localized change
- **M** — several components or moderate design work
- **L** — substantial integration or state-management work
- **XL** — high uncertainty or cross-cutting orchestration work

## Delivery phases

1. **Foundation:** FLUE-001–005
2. **Repository safety:** FLUE-006–009
3. **Agent system:** FLUE-010–015
4. **Quality and publication:** FLUE-016–017
5. **Operations:** FLUE-018–019
6. **Acceptance:** FLUE-020
7. **Follow-up defects:** FLUE-021+

## Tickets

| Ticket | Title | Difficulty | Dependencies |
|---|---|---:|---|
| [FLUE-001](FLUE-001-initialize-project.md) | Initialize and baseline the project | S | None |
| [FLUE-002](FLUE-002-validate-flue-integration.md) | Validate Flue orchestration integration | L | FLUE-001 |
| [FLUE-003](FLUE-003-test-harness.md) | Establish the automated test harness | M | FLUE-001, FLUE-002 |
| [FLUE-004](FLUE-004-configuration.md) | Implement configuration and model-provider resolution | M | FLUE-002, FLUE-003 |
| [FLUE-005](FLUE-005-cli-shell.md) | Build the `flue-agent` CLI shell | M | FLUE-003, FLUE-004 |
| [FLUE-006](FLUE-006-run-storage.md) | Implement persistent run storage | L | FLUE-003, FLUE-005 |
| [FLUE-007](FLUE-007-git-preflight.md) | Implement Git repository preflight checks | M | FLUE-003, FLUE-005 |
| [FLUE-008](FLUE-008-worktree-lifecycle.md) | Implement temporary worktree lifecycle | L | FLUE-006, FLUE-007 |
| [FLUE-009](FLUE-009-patch-publication.md) | Implement patch revision and publication | XL | FLUE-008 |
| [FLUE-010](FLUE-010-result-contracts.md) | Define structured subagent result contracts | M | FLUE-002, FLUE-003 |
| [FLUE-011](FLUE-011-role-capabilities.md) | Implement role-specific capability boundaries | L | FLUE-002, FLUE-003, FLUE-008 |
| [FLUE-012](FLUE-012-specialist-subagents.md) | Implement the four specialist subagents | M | FLUE-010, FLUE-011 |
| [FLUE-013](FLUE-013-delegation-ledger.md) | Implement the delegation and revision ledger | XL | FLUE-002, FLUE-006, FLUE-009, FLUE-010, FLUE-012 |
| [FLUE-014](FLUE-014-budgets-concurrency.md) | Implement orchestration budgets and concurrency controls | L | FLUE-004, FLUE-011, FLUE-013 |
| [FLUE-015](FLUE-015-orchestrator-policy.md) | Implement autonomous orchestrator policy | L | FLUE-012, FLUE-013, FLUE-014 |
| [FLUE-016](FLUE-016-review-gating.md) | Implement review, repair, and completion gating | XL | FLUE-009, FLUE-013, FLUE-014, FLUE-015 |
| [FLUE-017](FLUE-017-commit-handling.md) | Implement explicit commit handling | M | FLUE-009, FLUE-016 |
| [FLUE-018](FLUE-018-cancellation-resumption.md) | Implement cancellation and safe resumption | XL | FLUE-006, FLUE-008, FLUE-013, FLUE-015 |
| [FLUE-019](FLUE-019-reporting.md) | Implement reporting and run-management commands | L | FLUE-006, FLUE-013, FLUE-016, FLUE-018 |
| [FLUE-020](FLUE-020-acceptance.md) | Add behavioral evaluations, end-to-end tests, and documentation | XL | FLUE-003, FLUE-017, FLUE-018, FLUE-019 |
| [FLUE-021](FLUE-021-delegation-briefing-preflight.md) | Preflight delegation briefings before starting sub-agents | M | FLUE-013, FLUE-015, FLUE-019 |
| [FLUE-022](FLUE-022-runtime-malformed-result-correction.md) | Correct malformed runtime sub-agent results in place | L | FLUE-010, FLUE-013, FLUE-015, FLUE-021 |
| [FLUE-023](FLUE-023-truncated-subagent-result-recovery.md) | Recover from output-limit-truncated sub-agent results | M | FLUE-010, FLUE-014, FLUE-019, FLUE-022 |

## Critical path

```text
FLUE-001 → FLUE-002 → FLUE-003 → FLUE-005 → FLUE-006
→ FLUE-007 → FLUE-008 → FLUE-009 → FLUE-013
→ FLUE-014 → FLUE-015 → FLUE-016 → FLUE-017 → FLUE-020
```
