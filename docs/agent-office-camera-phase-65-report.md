# Agent Office + Camera Phase 65 — Verification Report

## Outcome

Phase 65 stabilizes the Mac/server side of Office calling and camera voice delivery
without changing ERP finance, payroll, inventory, attendance, orders, or the legacy
`/api/agent/*` surface. The current Office-PC scripts remain compatible; the updated
templates are ready for a later, separately approved physical deployment.

Before the approval preview, current `origin/main` (`517cf42b`) was merged into the
phase branch. The upstream files do not overlap the Phase 65 change set; the final
three-dot diff against current main remains restricted to the 22 locked files.

## What changed

### Office call safety and UI

- Canonically ended, locally dismissed, malformed, and stale outgoing calls can no
  longer take over the whole Office Hub recovery UI.
- Legacy/ringing recovery is limited to 60 seconds; canonical connected/reconnecting
  calls remain reload-recoverable within the existing two-hour call lifetime.
- Call-end HTTP failures now surface a Bangla error. A successful end is dismissed
  locally immediately, even if the feed projection is temporarily stale.
- Live-intercom Agora grants are restricted to the exact authenticated business
  channel. Owner is publisher; staff is subscriber. Direct calls remain
  participant-bound publishers.

### Camera voice control plane

- Camera speaker jobs use conditional atomic claims, two-minute lease identities,
  lease-expiry recovery, retry counts, and a ten-minute stale-announcement limit.
- Acknowledgements are lease-bound for upgraded bridges. Missing lease tokens remain
  accepted during migration until `camera_bridge_require_lease_token` is explicitly
  enabled.
- An acknowledgement now means only that go2rtc accepted the playback command. Owner
  notifications explicitly state that software cannot prove a human heard it.
- Failed Telegram outcome notifications remain unmarked and retryable.
- Listener and bridge auth are centralized with timing-safe comparison. The listener
  can use a separate `camera_listener_token`, with safe fallback to the deployed
  bridge token until the Office PC is upgraded.
- Listener GET and POST both enforce the agent kill switch and bearer authentication.
- Wake matching uses Unicode word boundaries, preventing `alma` from matching
  `Salma`. Cooldown and echo suppression are room-scoped.
- Declared oversized audio is rejected before buffering. Authenticated bridge and
  per-room listener heartbeats are recorded with 30-second write throttling.
- PowerShell templates now send lease tokens, use the dedicated listener token when
  present, and emit authenticated listener heartbeats.

## Database migration

- `20260719010000_camera_voice_control_plane_hardening` is additive only.
- Adds nullable `lease_token`, nullable `lease_expires_at`, non-null
  `attempt_count DEFAULT 0`, and a status/lease-expiry index.
- It is not applied manually from the Mac. The repository's existing Vercel deploy
  migration gate is the only authorized application path.

## Verification checklist

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused Office/camera tests | PASS | 6 files, 31 tests |
| Full test suite | PASS | 221 files, 2,627 tests |
| TypeScript | PASS | `npm run type-check` |
| Prisma schema | PASS | `prisma validate` with a non-production build URL |
| Lint | PASS | No errors; existing repository warnings remain |
| Production build | PASS | Local build; deploy migration correctly skipped off Vercel |
| Whitespace safety | PASS | `git diff --check` |
| Locked-file scope | PASS | Only Phase 65 prompt files changed |
| Vercel preview | PASS | Ready deployment `8oQFMN9CURpMDwE1bFpFABKzDL5K` from integrated tip `9ebe9c95` |
| Owner-Chrome browser proof | PASS | Authenticated Office Hub exercised on the exact branch preview; desktop and 390×844 screenshots captured |
| Physical camera proof | NOT IN PHASE | Requires later Office-PC/hardware session |

### Live browser proof

- Preview: `https://alma-erp-git-agent-phase-65-maruf-s-projects2.vercel.app/portal/office`
- The authenticated Office Hub remained usable after a hard navigation/reload; no
  ended, dismissed, or stale call recovery overlay appeared.
- The read-only Office History panel opened and closed successfully without starting
  a call, sending a reminder, or mutating business data.
- Default desktop and 390×844 mobile viewports both rendered the Office Hub with no
  document-level horizontal overflow. The temporary mobile override was reset.
- The live preview emitted zero browser-console errors and zero warnings during the
  exercised flow.

## Files

- Phase prompt/report and two Office-PC PowerShell templates.
- Additive Prisma schema/migration.
- Office intercom UI, token route, and two call policy/auth helpers.
- Camera bridge/listen routes and camera auth, health, voice-policy, and speak helpers.
- Six focused regression test files (two extended, four added).

## Decisions and boundaries

- No push or merge into the `main` branch, production deploy, Office-PC change,
  secret rotation, or environment change was performed. Current `origin/main` was
  merged only into the isolated phase branch to protect concurrent work.
- No claim of physical speaker playback or staff audio capture is made. Those require
  human hearing/microphone proof at the office.
- The preview URL and screenshot proof above were recorded only after the exact branch
  build was live and authenticated in the owner's Chrome.
