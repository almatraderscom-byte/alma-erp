# Office Calling — Phase 8 Support, Recovery and Release Runbook

This runbook is executable release procedure, not a claim that the release passed. Phase 8 remains
closed until the generated evidence JSON passes `scripts/office-call-release-gate.mjs` and the owner
explicitly approves it.

## 1. Required equipment and accounts

- Two physical iPhones capable of the supported iOS version, labelled `iPhone A/B`.
- Two physical Android phones from at least two OEMs, labelled `Android A/B`.
- Two current desktop browsers/profiles, labelled `Web A/B`.
- One owner and one active staff account with exact business membership. A second staff account is
  recommended for busy/multi-device rows.
- Stable Wi-Fi, a cellular data plan on both native platforms, Bluetooth headset, wired headset where
  supported, and access to trigger a real GSM/other-VoIP interruption.

One iPhone plus one Android is enough for cross-platform smoke checks, but it cannot close the
iPhone↔iPhone or Android↔Android rows. Do not substitute simulators/emulators for Phase 8 evidence.

## 2. Freeze one release candidate

1. Start from the final `agent/office-calling-whatsapp` commit and record the full Git SHA.
2. Run the full calling suite, type-check, lint, Prisma validation, Android release build, iOS archive
   and web production build. Any source change after this point invalidates prior matrix rows.
3. Deploy that exact SHA to the release backend. Verify the SHA through `/api/build-info` and the
   owner-only `/api/assistant/office/calls/diagnostics` response.
4. Confirm the iOS archive and Android release artifact embed the same SHA. Inspect the signed iOS
   entitlements and Android merged manifest/APK; do not infer signing correctness from source files.
5. Record build numbers, artifact checksums, preview/release URL and signing channel in the evidence.

## 3. Release-backend configuration preflight

Check presence and environment correctness without copying secret values into evidence:

- `OFFICE_CALL_SESSIONS_ENABLED=true`
- `OFFICE_CALLS_KILL_SWITCH=false` for the active test window
- `OFFICE_CALL_ROLLOUT_PERCENT` set to the intended preview/canary cohort
- `OFFICE_CALL_DEVICE_KEY`, `NEXTAUTH_SECRET`, `CRON_SECRET`
- Agora app ID/certificate
- APNs VoIP key/team/key ID, production flag and app bundle/topic
- FCM service-account configuration
- database migration containing Office call session/event/device/outbox tables and constraints

The diagnostics endpoint must report Agora, encrypted device registry and at least one direct native
push provider configured. A `DEAD` delivery outbox, stuck session or provider alert is a stop signal.

## 4. Generate and fill the evidence file

Generate all **264** bidirectional matrix rows:

```bash
node scripts/office-call-release-gate.mjs --template > phase-8-results.json
```

For every row record a real UUID call ID, server event IDs, both device-log references and a short
screen recording/screenshot reference. Mark every assertion only after checking server truth, both
clients, system UI, Agora membership, two-way audio, call history and event-ledger completeness.

Validate at any time:

```bash
node scripts/office-call-release-gate.mjs phase-8-results.json
```

The command exits non-zero and lists exact missing/failed evidence until every release gate passes.
Never edit the validator to make a failing artifact pass.

## 5. Physical matrix execution discipline

Run the roadmap's 22 scenarios for all 12 directional pairs. Reset to known state between rows:

1. End any previous call and confirm no active server session, CallKit/Telecom UI or notification.
2. Confirm correct user/account on each device and record connectivity/audio route.
3. Start screen recording and filtered native/server logs before placing the call.
4. Execute only the named scenario. Use the server timeout for the missed-call row.
5. Record the call UUID and correlate every state transition before moving to the next row.
6. If any assertion fails, mark `FAIL`, preserve logs/video, diagnose/fix, create a new signed candidate
   and restart affected rows. Never overwrite failure evidence.

Useful capture commands when the phones are reconnected:

```bash
adb devices -l
adb logcat -c
adb logcat | rg 'OfficeCall|Agora|Telecom|FirebaseMessaging|CallNotification'
adb shell dumpsys telecom
adb shell dumpsys notification
xcrun devicectl list devices
```

Use Xcode's device console for filtered `OfficeCall`, `CallKit`, `PushKit` and Agora logs. Evidence
must contain references, not raw push tokens, cookies, certificates, phone numbers or email addresses.

## 6. 100-call and long-call soak

- Run at least 100 additional mixed-platform calls across every directional pair. Randomize answer,
  decline, cancel, timeout, route change, background and network-churn cases.
- Each soak call needs a unique UUID and must have two-way audio, correct terminal history, complete
  event ledger and zero stuck UI/notification.
- Run a connected call beyond 60 minutes so the one-hour Agora token renewal is observed. Record the
  renewal event, continuous audio evidence and correct terminal state.
- Stop immediately on a stuck call, missing terminal transition, wrong recipient, privacy leak or
  unbounded reconnect. Preserve the first failure before attempting a fix.

## 7. SLO and canary ladder

Release targets:

- Locked native push-to-ring p95 ≤ 5,000 ms.
- Answer-to-two-way-audio p95 ≤ 3,000 ms.
- End/decline/cancel propagation p95 ≤ 2,000 ms.
- Stuck sessions/rings/notifications: zero.
- Correct terminal history and native background survival: 100%.

Capture a baseline, then use stable server cohorts: preview testers → 5% → 25% → 50% → 100%.
At every rung compare platform/build slices and do not advance on an alert or >10% latency regression.
Production holds should cover real business usage; a quick synthetic burst is not a canary substitute.

## 8. Rollback drill

Before release, time this drill against the release backend:

1. Set `OFFICE_CALLS_KILL_SWITCH=true` through the controlled Vercel environment/redeploy path.
2. Prove new placement returns `calling_disabled` while the documented active-call policy remains
   deterministic.
3. Confirm no migration/data rollback is needed and existing terminal events remain queryable.
4. Restore the previous configuration and prove placement recovers.
5. Record duration and deployment/log reference. Target ≤ 300 seconds.

If the environment/redeploy control cannot meet the target, do not claim an operational kill switch;
add a dynamic authenticated control before release.

## 9. User permission and recovery guide

### iPhone

- Microphone: **Settings → Privacy & Security → Microphone → Alma ERP** on.
- Notifications: **Settings → Notifications → Alma ERP**; allow alerts, sounds and lock-screen alerts.
- Cellular/background: allow Cellular Data and Background App Refresh for Alma ERP.
- Audio: use the system call audio button for earpiece/speaker/Bluetooth. Reconnect the headset if the
  route is missing.
- If a call is stuck: end it from system call UI, reopen Alma ERP, confirm history is terminal, then
  capture the call ID before retrying. Reinstall only after logs are preserved.

### Android

- Permissions: Alma ERP App info → Permissions → Microphone and Nearby devices allowed.
- Notifications: allow call notifications; enable full-screen/special app access if the OS/OEM offers
  it. Keep the call notification visible during an active background call.
- Battery/data: allow background data and set Battery to Unrestricted for the test. Record the OEM
  setting because production users may have stricter defaults.
- Audio: select earpiece/speaker/Bluetooth from the call UI/system call controls.
- If a call is stuck: end from system UI/notification, force-stop only after capturing `adb logcat`,
  reopen and verify server history before retrying.

### Web

- Address-bar lock icon → Microphone → Allow. Close other tabs/apps holding the microphone.
- Keep one live media-owner tab per call. If the page reloads, use the recovery prompt instead of
  starting a second call.
- Browser background incoming reliability is best effort; locked/killed incoming-call guarantees are
  native-app requirements.

### Support triage data

Collect: time/timezone, caller/callee roles, business, call UUID, app build/SHA, OS/browser version,
network and audio route, visible error, diagnostics alert names and log/video references. Never ask a
user to send an auth cookie, Agora token, APNs/FCM token or private key.

## 10. Final go/no-go

Release is `GO` only when:

- the release-gate script returns `pass: true`;
- the Phase 7 dependency exception is closed or explicitly owner-accepted with compensating controls;
- all signed artifacts and backend report the exact frozen SHA;
- the complete physical matrix, soak, long-call renewal, canary comparison and rollback drill pass;
- the owner signs the evidence record.

Only after that evidence may the feature be described as WhatsApp-like and the legacy broadcast call
path be removed. Any other state is `NO-GO`.

