# Office Calling release candidate — iOS 79 / Android 20

Date: 2026-07-18 Asia/Dhaka

## Fixed release target

- iOS TestFlight must be build **79**, produced only by the manual GitHub Actions
  `iOS TestFlight Upload` workflow from current `main`.
- The calling implementation was first merged onto the latest build-78 `main`
  baseline and reverified in the approved IOSP0 simulator before build 79 was bumped.
- Android OTA is build **20**. It is intentionally newer than both the published
  build 17 and the device-recovery build 19.
- Android installs below build 20 must receive a blocking update gate and cannot
  use the app after the server minimum is activated.

## iOS build-78 simulator evidence

- Baseline: `origin/main` `8d8bd109`, merged into the calling branch by `97f2e541`.
- Simulator: iPhone 17 Pro Max IOSP0,
  `9E51818A-AA25-4C9F-9C1F-9EE2D99E2998`.
- Built bundle: `CFBundleVersion=78`, `CFBundleShortVersionString=1.0`,
  `ALMAGitCommit=69e4cabeaa`.
- Unsigned Debug simulator build: PASS.
- Install and launch: PASS.
- `ALMA_CRASH_REPRO=1` call-reset regression: app launched as PID `93615`; after
  the delayed `AgoraIntercom.leave()` trigger the same PID remained alive and the
  authenticated dashboard rendered. No SIGTRAP/fatal crash was present in the
  recent simulator log.
- Limitation: Simulator does not prove real APNs/PushKit delivery, CallKit on a
  locked physical iPhone, or two-device Agora audio. Those remain the signed
  physical release matrix.

## Android mandatory-update evidence

Live state inspected before changing the candidate:

- `/api/app/native-version`: `minBuild=17`.
- Published APK: versionCode `17`, versionName `1.2.5`, SHA-256
  `ba949a312889b34c98cfafcdf45c60130ce65e538a97fdad451b9fab1b30d0c0`.
- Published signer SHA-256:
  `22e7323a2112608e2202c71b83cf3aad6688529840590d548aba0bbfa447b3c8`.

Candidate evidence:

- versionCode `20`, versionName `1.2.7`.
- R8 arm64 release APK: 46 MB, SHA-256
  `ac04fe92d8098b14eff6ac3d2ae0e58b0863e3bbf182721ac8f7859bace2c0a9`.
- Candidate signer SHA-256 exactly matches the published APK signer, so Android
  accepts it as an in-place upgrade for existing installs.
- `testDebugUnitTest`, `assembleDebug`, `compileDebugKotlin`,
  `compileReleaseKotlin`, R8/resource shrink and `assembleRelease`: PASS.
- The native update gate is now the final/topmost Compose child, so login,
  connectivity UI, native screens and WebView content cannot cover or bypass it.
- The native gate rechecks every 30 seconds. An initial network failure stays
  fail-open to avoid bricking an offline workforce; after an authoritative
  too-old result, transient failures do not remove the block.

Android will not permit a normal app to silently install an APK. The enforceable
contract is: block all ERP UI -> require download -> Android package installer
confirmation -> only build 20 or newer can use the app. Staff may also need to
allow “Install unknown apps” for the browser used to download it.

## Safe activation order (hard gate)

1. Merge the verified candidate to `main`.
2. Upload the exact build-20 APK above to the existing Supabase
   `app-releases/alma-erp.apk` object.
3. Download it again from the public URL and verify versionCode 20, SHA-256 and
   signer certificate before changing the server minimum.
4. Set `agent_kv_settings.min_native_android_build` to `20`.
5. Verify the live API returns `minBuild=20` and the public URL still returns the
   verified build-20 APK.
6. On an old physical install, prove the gate blocks navigation, downloads the
   APK, installs in place without data loss, and opens build 20.

Never raise `min_native_android_build` before the public object is verified; that
ordering would lock every old Android user onto a missing or incompatible file.

## TestFlight pipeline hardening

The manual workflow now requires an `expected_build` input (default `79`) and
refuses to upload unless:

- the selected ref is `main`;
- checked-out HEAD exactly equals current `origin/main`;
- all Xcode project build-number entries agree;
- the committed number equals the requested number;
- the checkout is clean before runtime SHA stamping;
- the 9 focused Office Calling files (55 tests) and TypeScript typecheck pass.

The workflow then stamps the exact GitHub SHA, archives with cloud signing, and
uploads build 79 to TestFlight. It remains manual/owner-triggered and never runs
on push.

## Current verdict

**ENGINEERING PASS / SIGNED PHYSICAL RELEASE GATE PENDING.**

The strongest non-device verification is green. Do not describe WhatsApp-like
calling as fully released until the roadmap Phase 8 physical iPhone/Android/web
matrix passes against these signed artifacts.
