# iOS Notification Reliability — TestFlight Handoff (2026-07-24)

## Owner directive

Maruf wants the receiving session to combine its own current iOS work with this
notification branch, verify the combined candidate, and then deliver one
TestFlight build. Do not build from this branch in isolation: it was deliberately
kept separate while another iOS session continued in parallel.

This handoff session did **not** create or upload a TestFlight build.

## Source branch and immutable core commit

- Branch: `codex/ios-notification-audit`
- Core implementation commit: `63c90386599e65873e6ba4c68c217d26d7448cd1`
- Pre-change tag: `pre-ios-notification-audit-20260723`
- Vercel preview:
  `https://alma-erp-git-codex-ios-notification-audit-maruf-s-projects2.vercel.app`
- Live settings proof:
  `https://alma-erp-git-codex-ios-notification-audit-maruf-s-projects2.vercel.app/settings/notifications`

At handoff time this branch was based on `9012e75f` and was 8 commits behind
`origin/main`. That is intentional. **Never archive or upload this branch as-is.**
The receiving session must first combine it with the latest main and its other
active iOS work.

## What this branch fixes

### 1. Notification taps opened Dashboard instead of their actual page

Root cause: the app relied on a late JavaScript OneSignal click listener inside a
hidden Capacitor webview. On a cold launch the click could arrive before that
listener or before the native tab shell existed. Full production URLs also failed
the old hidden-webview origin check.

Permanent path:

- `AppDelegate` registers the native OneSignal click listener at launch.
- The internal `routePath` is stored durably in `UserDefaults`.
- The pending route is replayed only after the native shell exists and survives
  biometric/cold-start races.
- Delivery IDs and a short dedupe window prevent the native and JS callbacks from
  opening the same page twice.
- Root routes select the correct native tab; other routes use the existing smart
  native/web router.

### 2. Agent completion push disappeared after leaving the app

Root cause: completion push was tied to an inline streaming request and a
fire-and-forget serverless callback. Leaving the app could close that request.
The old presence heartbeat also kept the owner falsely "active" for about 50
seconds after backgrounding, which suppressed the push.

Permanent path:

- Every successful app/web Agent turn first creates a durable database delivery.
- A leased outbox retries transient OneSignal/config/subscription failures up to
  eight times with exponential delays.
- The VPS worker sweeps due deliveries every 60 seconds.
- Foreground/background is now an explicit lifecycle state; background takes
  effect immediately.
- Native Agent push defaults on unless the explicit kill switch is `false`.
- A stable turn ID is used as the OneSignal collapse/delivery ID.
- Agent completion and approval pushes carry `/agent` as their native route.

### 3. No professional role/user notification controls

Permanent path:

- Per-user preferences: master enable, high-priority-only, critical-always,
  Agent completions, approvals, orders, payroll/wallet, inventory, finance, and
  announcements.
- Preference filtering happens before recipient rows and push delivery.
- Subscription role and external user ID come from the authenticated session,
  never client input.
- Notification inbox reads materialized recipient rows only; there is no
  role-target read bypass.
- Every authenticated role can open notification settings.
- Staff sees personal controls and its own push health. Admin/Super Admin also
  sees team health, broadcast controls, metrics, and delivery history.

## Database state

Additive migration:

`prisma/migrations/20260723235500_notification_preferences_and_turn_delivery/migration.sql`

It creates:

- `notification_preferences`
- `agent_turn_notification_deliveries`

The Vercel preview successfully applied this migration to the configured shared
Supabase database on 2026-07-24. Do not recreate, rename, or destructively alter
these tables. `prisma migrate deploy` should report them as already applied.

## Files most likely to conflict with the receiving iOS session

Resolve these by preserving both behaviors, never by choosing one side wholesale:

- `ios/App/App/AppDelegate.swift`
- `ios/App/App/AssistantSwiftUI.swift`
- `ios/App/App/SwiftUIShell.swift`
- `ios/App/App/SpikeNativeShell.swift`
- `ios/App/App/SettingsNotificationsSwiftUI.swift`
- `ios/App/App/AlmaNavBridge.swift`
- `src/agent/components/AgentApp.tsx`
- `src/app/api/assistant/chat/route.ts`
- `worker/src/index.mjs`

The complete changed-file list is available with:

```bash
git show --stat --oneline 63c90386
```

## Required integration procedure

1. Fetch remote truth first:

   ```bash
   git fetch origin --prune
   ```

2. Identify the receiving session's active iOS branch and all unmerged work. Do
   not discard or overwrite it.
3. Create one clean candidate from the latest `origin/main`, or update the
   receiving candidate until it contains the latest `origin/main`.
4. Integrate the receiving session's own commits and the notification core
   commit `63c90386`. Cherry-picking the core commit onto the main-current
   candidate is acceptable; merging `origin/codex/ios-notification-audit` is
   also acceptable.
5. Resolve the conflict hotspots above by retaining both feature sets.
6. Confirm the candidate is clean, pushed, and contains current main:

   ```bash
   git status --short
   git merge-base --is-ancestor origin/main HEAD
   git log --oneline origin/main..HEAD
   ```

7. Do not use `ALMA_PREFLIGHT_ALLOW_BRANCH=1` for a real TestFlight upload.

## Mandatory verification before release

Run all of these on the combined candidate:

```bash
npm ci
npx prisma validate
npx prisma generate
npx vitest run src/lib/__tests__/notification-preferences.test.ts
npm run type-check
npm run build
git diff --check
cd ios/App && pod install --deployment --no-repo-update
```

Then build/install the Debug app on an iOS simulator using the repo's normal
workspace/scheme and exercise:

1. Cold notification route `/agent` opens Assistant, not Dashboard.
2. Cold notification route `/orders` opens Orders.
3. Cold notification route `/settings/notifications` opens notification
   settings.
4. Biometric unlock does not reset the selected notification destination.
5. Notification preference save survives reload, then restore the owner's
   original value.
6. Owner Chrome preview has no console error on `/settings/notifications`.

The debug-only simulator harness is:

```bash
SIMCTL_CHILD_ALMA_NOTIF_COLD_TAP=/agent \
  xcrun simctl launch --terminate-running-process <UDID> com.almatraders.erp
```

Repeat with `/orders` and `/settings/notifications`. The harness feeds the same
durable native route store used by the real OneSignal callback; it is excluded
from Release/TestFlight behavior.

## Verification already completed on the source branch

- Prisma validate/generate: PASS
- Notification preference tests: 4/4 PASS
- TypeScript: PASS
- Production Next.js build: PASS
- Changed-file lint: 0 errors
- Xcode Debug simulator build: PASS
- Vercel preview: READY
- Preview migration: applied successfully
- Live Chrome save -> reload persistence -> restore -> reload: PASS
- Live Chrome console errors: 0
- Simulator `/agent`, `/orders`, and `/settings/notifications` routing: PASS

These are source-branch proofs, not permission to skip verification after
combining another session's work.

## Real-device checks required on the TestFlight candidate

After the candidate is available on the owner's iPhone:

1. Kill the app, tap an Orders notification, and confirm Orders opens.
2. Kill the app, tap an approval notification, and confirm its intended page
   opens rather than Dashboard.
3. Start an Agent task, background/leave the app before completion, wait for the
   completion notification, then tap it and confirm Assistant opens.
4. Repeat the Agent test once with the app foregrounded: no redundant completion
   push should appear while the answer is already visible.
5. With a Staff account, verify personal switches are available but team
   broadcast/metrics are hidden.
6. Verify high-priority-only blocks Normal/Low notifications while High/Critical
   still arrive; restore the preference afterward.
7. Verify critical-always can pierce master-off, then restore the preference.

Do not claim the physical-device behavior passed until these steps are actually
observed on the installed candidate.

## TestFlight release gate

The current GitHub workflow `.github/workflows/ios-testflight.yml` is hard-coded
to current `main`. Project rules also prohibit an agent from merging to main.
Therefore the receiving agent must:

1. Prepare and push the combined, verified candidate branch.
2. Open a PR and report the exact candidate SHA and evidence.
3. Have Maruf merge/approve the candidate into main.
4. Fetch current main and determine the next unused
   `CURRENT_PROJECT_VERSION`; never assume the workflow's displayed default is
   still available.
5. Commit and push the build-number bump so Git remains the source of truth.
6. Run `bash scripts/ios-build-preflight.sh` and fix every failure.
7. Trigger the manual workflow from current main with the exact committed build:

   ```bash
   gh workflow run ios-testflight.yml \
     --ref main \
     -f expected_build=<BUILD_NUMBER>
   ```

8. Watch the workflow through upload completion and report the build number,
   workflow URL, commit SHA, and `ALMAGitCommit`.

Maruf's 2026-07-24 instruction authorizes the receiving session to proceed with
the TestFlight build after it has combined its own work with this branch and all
gates above pass. A newer conflicting owner instruction still takes precedence.

## Hard boundaries

- Never touch `/api/agent/*`.
- Never merge to main on the owner's behalf.
- Never upload from a dirty, unpushed, or behind-main checkout.
- Never expose or commit App Store Connect, OneSignal, Supabase, or other secrets.
- Never use simulator screenshots as proof of physical APNs delivery.
- Preserve every existing ERP and native iOS feature while resolving conflicts.
