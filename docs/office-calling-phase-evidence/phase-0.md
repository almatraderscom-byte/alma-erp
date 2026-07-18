# Office Calling Phase 0 Evidence

- Date: 2026-07-17 (Asia/Dhaka)
- Branch: `agent/office-calling-whatsapp`
- Audited base SHA: `6d7843abb6f31f95cb442f79e2488ef60861cef7`
- Roadmap commit: `9ba710bc`
- Deployment: initially skipped; owner authorized Vercel verification later on 2026-07-17

## Implemented

- ADR for server ownership, target state machine, constants, privacy rules, and physical-device lab.
- Append-only `office_call_events` Prisma model and additive migration.
- Server events for call creation/end, duplicate end, push target resolution, APNs/FCM/OneSignal
  outcomes, and Agora token minting.
- Participant-bound one-to-one Agora token minting; arbitrary malformed call channels rejected.
- Authenticated client event API for web/iOS/Android with participant checks, timestamp bounds,
  bounded metadata, secret-key redaction, and HMAC-pseudonymized device identifiers.
- Owner-only call diagnostics API with backend build SHA/environment, provider configuration,
  registered-device counts, frozen contract, call summary, and recent correlated events.
- Web, iOS, and Android lifecycle telemetry with app build/device correlation.
- Misleading receipt comments corrected: receipts do not cancel other devices.
- Android ring window aligned with web/iOS at 60 seconds.

## Automated and build evidence

| Check | Result |
|---|---|
| `npx prisma generate` | PASS — Prisma Client 5.22.0 generated |
| `DATABASE_URL=<non-connecting placeholder> npx prisma validate` | PASS — schema valid; no DB connection attempted |
| Focused Vitest observability suite | PASS — 1 file, 6 tests |
| `npm run type-check` | PASS |
| Focused ESLint on all changed TypeScript | PASS |
| `npm run build` | PASS — Next.js production build, 373 static pages; existing OpenTelemetry warnings only |
| Android `:app:compileDebugKotlin` | PASS — 158 tasks, one changed-file deprecation warning only |
| iOS simulator Xcode Debug build | PASS — `BUILD SUCCEEDED` on iPhone 17 Pro Max IOSP0 |
| iOS simulator install/launch | PASS — process `com.almatraders.erp: 77266`; clean Dashboard launch |

Screenshot: [phase0-ios-launch.png](phase0-ios-launch.png)

## Vercel preview verification

- Verification commit: `865b89e4ca82358acacf0738b65c823bd3e8fd1e`
- Deployment: `dpl_BMcRDv45oKMhVmAAYC3oRvnMjzzK`
- Environment: Vercel Preview (not production)
- Preview alias: `alma-erp-git-agent-office-calling-whatsapp-maruf-s-projects2.vercel.app`
- Final state: `READY`; GitHub Vercel status `success`
- The repository-standard ignore script detected web-relevant changes and allowed the build.
- Build logs confirm Prisma Client generation, successful Next.js compilation, 373-page static
  generation, and Sentry release `865b89e4ca82358acacf0738b65c823bd3e8fd1e`.
- Browser verification passed Vercel SSO protection and loaded the Alma ERP sign-in page from the
  preview alias.
- With Vercel protection bypassed, unauthenticated requests to both
  `/api/assistant/office/calls/diagnostics` and `/api/assistant/office/calls/events` returned
  `401 {"error":"Unauthorized"}`. This proves the deployed application auth boundary rejects the
  requests; the rejected POST did not write an event.

## Migration status

Vercel build logs show `prisma migrate deploy` connected to the configured Supabase PostgreSQL
database, applied `20260919120000_office_call_events`, and reported `All migrations have been
successfully applied` followed by `[migrate-on-deploy] migrations up to date`.

## Secret review

- Unit test proves token/authorization-shaped metadata keys are redacted.
- Provider delivery summaries retain counts/status categories only; raw device tokens and raw
  provider response bodies are not persisted.
- Native/browser device IDs are HMAC-pseudonymized before database persistence.
- Diagnostics exposes configuration booleans, never credentials.

## Required Phase 0 hard-gate evidence still unavailable

- No physical two-iPhone/two-Android/web call was placed against this branch.
- Therefore no real call can yet be correlated create → push → ring → answer → Agora join →
  connected → end, nor can an intentional provider/device failure be correlated.
- The migration and APIs are now deployed on the successful preview, but owner-authenticated
  diagnostics and participant-authorized event ingestion were not exercised because this
  verification session had no Alma ERP owner login on the preview domain.
- The deployed backend SHA still cannot be matched to tested physical clients.
- A visual call-specific build badge still needs validation in the physical-device diagnostics UX;
  the API and every client event already carry the build identifiers.

## Physical-build attempt and recovery evidence

- Xcode detected the physical iPhone, confirmed Developer Mode, and successfully mounted a compatible
  developer disk image after the phone was unlocked. A full call was not started before the owner
  chose to batch physical testing into Phase 8.
- A physical Android 16 device was detected and authorized. The preview-configured APK compiled,
  matched the installed debug signing certificate, installed in place, and preserved app data.
- The preview APK was immediately replaced with recovery build `versionCode=19`, generated with the
  production-safe default. Inspection of both `assets/capacitor.config.json` and all compiled DEX
  files proved the preview hostname was absent and `https://alma-erp-six.vercel.app` was present.
- Build-time endpoint overrides are now explicit on web shell, native Android, and native iOS; their
  committed/default behavior remains production. No bypass secret or Vercel environment credential
  was downloaded, embedded, logged, or committed.

## Owner-approved deferred-device decision

On 2026-07-17 the owner requested that repeated phone setup and the full cross-platform matrix be
batched after the implementation phases. Phases 0–7 therefore require the strongest available
non-device gate and must list hardware rows as `DEVICE DEFERRED`. Phase 8 remains a mandatory physical
release gate; this decision does not claim call reliability or WhatsApp-like acceptance early.

## Gate verdict

**PHASE 0: ENGINEERING PASS / DEVICE DEFERRED — 2026-07-17 Asia/Dhaka.**

Schema/migration, focused tests, typecheck/lint/build, Android compile/install/recovery, iOS simulator
build, preview deployment, application-auth rejection, privacy review, and build correlation are
green. Physical success/failure correlation is explicitly deferred rather than claimed. Under the
owner-approved schedule Phase 1 may start; Phase 8 and release remain blocked on the complete signed
physical matrix.
