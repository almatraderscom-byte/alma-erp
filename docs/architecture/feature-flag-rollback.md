# Feature Flag & Rollback Contract (G01 / SPEC-008)

Source: `src/agent/contracts/feature-flag.ts`. Realises INV-08.

## Modes (frozen)
| Mode | legacy authoritative | new path run | compared | violations reported | new authoritative |
| --- | --- | --- | --- | --- | --- |
| off | ✓ | | | | |
| shadow | ✓ | ✓ | ✓ | | |
| warn | ✓ | ✓ | ✓ | ✓ | |
| enforce | | ✓ | | ✓ | ✓ |
| rollback | ✓ | | | | |

## Migration ladder
`off → shadow → warn → enforce` (no skipping). **rollback is reachable from any
mode.** `rollbackTarget(flag)` returns last-known-good (never `enforce`), else
`off`. `getMode` defaults unknown flags to `off` (fail-safe).

Every later group migrates its component through this ladder; the group rollback
drill (git revert) is the repo-level counterpart proven per spec.

Rollback: `git revert --no-edit <SPEC-008 commit>`.
