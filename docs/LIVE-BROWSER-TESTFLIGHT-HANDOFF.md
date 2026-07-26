# Live Browser — handoff before the TestFlight build

**Written for:** whichever agent session ends up doing the TestFlight build, after the
owner's *other* parallel session finishes its own work.

**The owner's instruction that produced this doc:** merge this work to main, write the
handoff, and let a later session verify **both** streams of work **together** in the
simulator, get his explicit confirmation, and only then archive a TestFlight build.

**So: do not archive a build off this doc alone.** The whole point is that his other
session's iOS changes and these land in ONE build, verified together. One build, not a
drip — that rule exists because builds 63–69 each dropped shipped features.

---

## 1. What this work is

The agent got a browser on the VPS that the owner can watch and reach into, and the
phone got the screen for it.

Before: an approved browser task ran headless on the VPS and handed back a screenshot.
Fine until a page asked for a login or threw a captcha, at which point the task was
simply dead — nobody was at the keyboard. And a business-login task (Facebook Ads) ran
from a datacenter IP with no owner login, which cannot work and risks a Meta security
checkpoint just by being attempted.

Shipped, in order:

| | What | Where |
|---|---|---|
| P0 | Three drivers — `vps` / `vps_live` / `companion` | `src/agent/lib/browser/drivers.ts` |
| P1 | Domain rule: business logins can only run in the owner's own Chrome | same |
| P1b | Companion execution bridge (BrowserStep → extension commands) | `src/agent/lib/browser/companion-bridge.ts` |
| P2 | Per-conversation "don't ask again" consent | `src/agent/lib/browser/consent.ts` |
| P3 | Live view — CDP screencast over SSE, input over POST | `worker/src/browser/live-session.mjs` |
| P4 | Call-aware guard, one session, idle pause, kill-switch | same + `live-client.ts` |
| P5/P6 | Saved per-site logins with a disk budget the owner can clear | `worker/src/browser/profile-store.mjs` |
| N0 | Tunable stream (fps / quality / width) | `live-session.mjs` |
| N1 | `open_live_browser` tool — start it from chat | `src/agent/tools/browser-live-tools.ts` |
| N2 | Native SwiftUI live screen | `ios/App/App/BrowserLiveSwiftUI.swift` |
| N3 | iOS hub entry + native router case | `AgentHubSwiftUI.swift`, `AlmaNativeRouter.swift` |

Merged to main as PRs **#607**, **#609**, and the N-series PR referenced at the bottom
of this file.

---

## 2. The rules this feature lives under — do not quietly relax them

**The domain rule is not a preference.** Meta/Facebook/Instagram, Google Ads and
payments, bKash/Nagad/Rocket, the banks, the payment gateways, the couriers, and the
infra consoles (Vercel/Supabase/GitHub/Hostinger) resolve to the `companion` driver
BEFORE any requested driver is honoured. A head model asking for `vps` on facebook.com
does not get it; the attempt is recorded on the pending action rather than dropped. The
owner can ADD domains via `browser_owner_only_domains` (KV); nothing can remove a
built-in one, and a KV read failure cannot widen what the VPS may touch.

**The call audio is frozen** (CLAUDE.md rule #1). This work changed **no voice or SIP
file at all** — verify that stays true before the build:

```bash
git diff origin/main...HEAD --name-only | grep -iE "voice-relay|gemini-live-bot|sip" || echo NONE
```

The eight locked values must read `12 · 4 · 35 · 60 · 500 · 50 · 2 · 500`, voice Charon.

**What the live session does to protect the call:** it refuses to start while a call is
up, and pauses itself when one arrives mid-session (the page keeps its state, so the
owner resumes where he was). Measured cost of a live session on the box: Chromium ~10%
of one core, load average did not rise (0.07 idle → 0.05 with a viewer attached), SIP
gateway 0.4% CPU at the same moment. **The VPS has two cores** — that is why the fences
are tight, and why nobody should raise the fps ceiling casually.

One subtlety worth keeping: the call check fails **closed when STARTING** a session and
**rides out a single blip** for a session already running. An earlier build failed
closed on every timeout, and a busy Chromium made a local HTTP call miss a 3s deadline —
so the live view paused itself precisely when it was being used. That is the feature
fighting itself; don't reintroduce it.

**The three switches have confusable names.** Two are called "লাইভ ব্রাউজার" in Bangla:

| key | which machine |
|---|---|
| `live_browser_enabled` | the owner's own Mac Chrome (companion extension) |
| `browser_live_view_enabled` | the VPS browser he can watch and take over |
| `browser_agent_enabled` | running browser tasks on the VPS at all |

The prompt requires the head to ASK which he means. `browser_live_view_enabled` is
already **true** in production (set 2026-07-26 via an approval card).

---

## 3. What is already proven, and how it was proven

Do not re-do these from scratch; re-run them only if you touch the relevant code.

**Server side (on the VPS, `/opt/alma-erp`):**
- session starts, navigates, streams; **static pages stream too** (CDP only emits on
  repaint, so there is a 1 fps floor capture and the newest frame is cached and pushed
  the instant a viewer connects);
- typing and Enter genuinely reach the page (proved by the URL gaining
  `?q=alma+lifestyle+bangladesh`);
- cookies persist across sessions (3 cookies written to the profile DB, still there
  after reopening the same profile);
- all three cleanup paths: `clear_cache` freed 1.68 MB and kept the login,
  `clear_site` and `clear_all` removed it;
- bad token → 401, unknown input type → rejected, VPS-driver task posted to the
  companion endpoint → 400 `driver_mismatch`.

**Companion bridge (the owner's real Chrome, from production):**
```
ok: True | device: My Mac Chrome
log: ['#1 navigate', '#2 wait', '#3 read_text', '#4 screenshot']
```

**Native iOS (simulator, iPhone 17 Pro Max):** the live screen renders VPS frames, and
**a tap inside the streamed image reached the page** — tapped a link on the phone, the
server reported `url after the iPhone tap: .../wiki/Search_engine_optimization` (from
`/wiki/Backlink`), and the new page came back to the phone.

**Bandwidth, measured (this was the real iOS risk):**

| | per frame | rate |
|---|---|---|
| desktop (5 fps, q50, 1280px) | ~120 KB | ~4.78 Mbit/s |
| phone (2 fps, q35, 720px) | ~39 KB | ~0.63 Mbit/s |

The phone must never be handed the desktop stream. Two bugs already did exactly that
and are fixed: the static-page capture used `page.screenshot()` (always full viewport,
ignoring `width`), and the relay silently dropped `stream` and `?fps`.

---

## 4. Known gaps — say these to the owner, don't discover them mid-build

1. **The simulator cannot take text input.** Taps work; the keyboard does not. So the
   URL field and the type-here field are UNVERIFIED in the simulator — they need the
   real device. Start sessions from the server side when testing in the sim.
2. **Input is per-keystroke over HTTP.** Serialised so ordering is correct (the web
   panel once turned "backlink" into "kbclanki"), but each character is a round trip.
   Fine for a password or a captcha; it is not a typing experience. If the owner
   complains about typing feel, the fix is batching, not more parallelism.
3. **Google bot-walls the VPS.** A test visit landed on `/sorry/index`. Datacenter IP,
   as predicted. Live view is the workaround (the owner passes it himself); the paid
   alternative is a stealth/residential proxy (~$20/mo Browserbase). The driver layer
   makes that a drop-in later — no code change.
4. **The agent acknowledged the request and stopped** without calling the tool on the
   first try; it needed a second nudge. Side effect of the "say the understanding
   first" rule. Worth a separate look, not a blocker here.
5. A duplicate `browser_live_view_enabled` approval card may still be pending (the
   owner was asked twice). The setting is already applied; the card can be rejected.

---

## 5. TestFlight build procedure — the gate is not optional

`CLAUDE.md` is the authority; this is the short form.

1. **Verify BOTH streams of work together in the simulator first**, then get the
   owner's explicit confirmation. That is the entire reason this doc exists.
2. Clean, pushed, main-current checkout. Then:
   ```bash
   bash scripts/ios-build-preflight.sh
   ```
   It hard-fails on a dirty tree, unpushed commits, a checkout missing origin/main
   work, or a non-main branch. **If it fails, fix the git state — never archive around
   it.** It stamps the commit SHA into Info.plist (`ALMAGitCommit`) so the .ipa is
   traceable.
3. Bump `CURRENT_PROJECT_VERSION`, commit (`chore(ios): bump build to N`) and **push
   before uploading**. The build number in git must equal the number on TestFlight.
4. Simulator build recipe used here:
   ```bash
   xcodebuild -project ios/App/App.xcodeproj -scheme App \
     -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
     -derivedDataPath /tmp/alma-sim-dd build
   ```
   Note: this project uses **explicit file references** in `project.pbxproj` — a new
   Swift file must be added in four places (PBXBuildFile, PBXFileReference, group
   children, Sources phase) or it fails with "cannot find X in scope".
5. Deployment target is **iOS 16**, so the two-parameter `onChange(of:initial:_:)` is
   unavailable even though other files use it. Use the single-parameter form.

---

## 6. How to re-verify the live browser quickly

The VPS service is `alma-browser-live` (pm2), port 8781, auth = `AGENT_INTERNAL_TOKEN`.

```bash
ssh root@31.97.237.40 'cd /opt/alma-erp/worker
T=$(grep -m1 "^AGENT_INTERNAL_TOKEN=" .env | cut -d= -f2- | tr -d "\"" | tr -d "\r"); H="Authorization: Bearer $T"
curl -s -X POST http://127.0.0.1:8781/live/start -H "$H" -H "content-type: application/json" \
  -d "{\"startUrl\":\"https://en.wikipedia.org/wiki/Backlink\",\"stream\":{\"fps\":2,\"quality\":35,\"width\":720}}"
curl -s http://127.0.0.1:8781/live/status -H "$H"
curl -s -X POST http://127.0.0.1:8781/live/stop -H "$H"'
```

Open the native screen in the simulator with:
```bash
xcrun simctl openurl <udid> "almaerp://agent/browser-live"
```
(`almaerp:///agent/browser-live` — three slashes — does NOT work; it arrives as
`//agent/browser-live` and hits the unknown-route alert.)

**Leave the box clean:** stop the session and check `GET /profiles` is back to
`{"profiles":[],"totalBytes":0}` if you created any test profiles. Saved logins are
real disk on the same box that runs the phone system.

---

## 7. Owner-facing summary, if he asks what he can do with it now

- Say **"VPS ব্রাউজার চালু করো"** — already on.
- Ask the agent to open it: it starts a session and replies with the link; from the
  phone the stream is sized for mobile data.
- On the phone: **Agent hub → Live Browser** (his own Chrome's feed is the separate
  "Live Watch" entry).
- Login or captcha: he passes it with his thumb, the agent finishes the job.
- **"cookie মুছে দাও"** → `manage_browser_logins`; `clear_cache` frees the disk and
  keeps the login, `clear_site`/`clear_all` mean logging in again — and the prompt
  requires saying that out loud before doing it.
