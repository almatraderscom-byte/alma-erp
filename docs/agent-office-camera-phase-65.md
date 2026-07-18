# Agent Office + Camera Phase 65 — Mac-side P0 Stabilization

## Objective

Stabilize the production Office call recovery and camera voice control plane without
changing existing ERP behavior or requiring an Office-PC deployment in this phase.
All server changes must remain backward-compatible with the currently deployed
PowerShell bridge/listener until a later physical setup phase.

## Baseline and isolation

- Branch: `agent-phase-65`
- Baseline tag: `pre-agent-phase-65`
- Baseline SHA: `5d536ea3ad413713184718ad2e0c5cc43911e86b`
- Isolated worktree: `/Users/marufbillah/alma-erp-agent-phase-65`
- The dirty `/Users/marufbillah/alma-erp` worktree is out of scope and must not be modified.

## Locked file scope

Only these files may be created or changed in this phase:

- `docs/agent-office-camera-phase-65.md`
- `docs/agent-office-camera-phase-65-report.md`
- `docs/office-pc-camera-bridge.ps1`
- `docs/office-pc-camera-listen.ps1`
- `prisma/schema.prisma`
- `prisma/migrations/20260719010000_camera_voice_control_plane_hardening/migration.sql`
- `src/app/portal/office/intercom.tsx`
- `src/app/api/assistant/office/intercom/call-token/route.ts`
- `src/app/api/assistant/internal/camera-bridge/route.ts`
- `src/app/api/assistant/internal/camera-listen/route.ts`
- `src/agent/lib/office-call-auth.ts`
- `src/agent/lib/office-call-web-policy.ts`
- `src/agent/lib/camera-auth.ts`
- `src/agent/lib/camera-health.ts`
- `src/agent/lib/camera-voice-policy.ts`
- `src/agent/lib/camera-say.ts`
- `src/agent/lib/__tests__/office-call-auth.test.ts`
- `src/agent/lib/__tests__/office-call-web-policy.test.ts`
- `src/agent/lib/__tests__/camera-auth.test.ts`
- `src/agent/lib/__tests__/camera-health.test.ts`
- `src/agent/lib/__tests__/camera-voice-policy.test.ts`
- `src/agent/lib/__tests__/camera-say.test.ts`

If any required fix needs another file, stop and amend this phase prompt explicitly
before editing that file.

## Required outcomes

1. A stale or canonically-ended outgoing call can never block the whole Office Hub.
2. Ending/recovering a call surfaces failures and dismisses a successfully ended call
   without waiting for a stale feed projection.
3. Live-intercom Agora tokens are restricted to the exact business channel; staff get
   subscriber privilege while the owner alone gets publisher privilege. Direct calls
   remain participant-bound publishers.
4. Camera speak claims become atomic leased claims with bounded recovery, retry count,
   and backward-compatible lease-token acknowledgements.
5. A bridge acknowledgement means only that the playback command was accepted; owner
   messages must not claim that a human heard it.
6. Failed owner outcome notifications remain retryable instead of being marked sent.
7. Camera-listen GET and POST both check `AGENT_ENABLED` and authenticate. Listener
   credentials may be separated but must fall back to the existing bridge token until
   the Office PC is upgraded.
8. Wake matching uses real word boundaries, cooldown and echo suppression are scoped
   per room, oversized audio is rejected before buffering, and authenticated bridge /
   listener heartbeats are recorded with write throttling.
9. Updated PowerShell templates send lease tokens and listener heartbeats, while the
   current deployed legacy scripts remain accepted by the server.

## Hard non-goals

- No `/api/agent/*` changes.
- No ERP finance, payroll, wallet, order, inventory, attendance, or unrelated UI changes.
- No manual production database mutation, environment change, merge, or production
  deployment. The additive migration may run only through the repository's existing
  Vercel deploy migration gate; it must never be applied ad hoc from this Mac.
- No Office-PC/AnyDesk change in this phase.
- No claim of physical speaker/listener success without later human hardware proof.

## Verification gate

- Focused Office call and camera tests pass.
- Full typecheck, full test suite, lint/build, and `git diff --check` pass.
- `git diff --stat` contains only the locked files.
- Phase branch is pushed for a Vercel preview only.
- The preview is exercised in the owner's Chrome and screenshots are captured before
  presenting it for approval.
- Stop before any merge or push to `main`.
