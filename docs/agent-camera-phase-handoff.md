# Camera Phase Handoff — Entrance Watch + Camera Speak (2026-07-03)

**Read this first if you are the agent starting a new session on the camera features.**
Everything below was built, deployed to production, and verified live (staff heard the
announcements by ear). Secrets are NOT in this file — see "Where secrets live".

---

## 1. What is DONE and LIVE in production

### Feature 1 — Entrance watch (কে ঢুকলো / অপরিচিত alert)
- `agent_known_people` table + reference photos in `agent-files` bucket (`known-people/<id>/`).
- Owner "Maruf" registered (2 photos, role owner). Staff photos NOT yet added.
- `src/agent/lib/face-match.ts` — Gemini multi-image identify (Flash scan → Pro confirm on stranger).
- `src/agent/lib/entrance-watch.ts` + cron `* * * * *` → `/api/assistant/internal/entrance-watch`
  (KV: `entrance_camera_device_id` = Office Entrance Room, `entrance_watch_enabled`,
  window `entrance_watch_start_hm`/`end_hm` default 24h, `entrance_alert_cooldown_min` 10).
- Admin page **`/agent/known-people`** — add people+photos, pick entrance camera, live test button.
- Office-absence alert now names who is visible / which known staff are missing.
- Limitation (by design, v1): 1-min polling can miss a fast walk-through; direction
  (in vs out) is not known — the alert photo shows it. Upgrade path: Imou
  `setMessageCallback` webhooks (researched, works — see memory).

### Feature 2 — Camera speak ("অফিসে বলো: …" → speaker)
- Owner (chat/Telegram) → head tool **`camera_speak`** (src/agent/tools/camera-tools.ts)
  → `queueCameraSpeak` (src/agent/lib/camera-say.ts) → Google TTS
  (src/agent/lib/google-tts.ts, voice bn-IN-Chirp3-HD-Charon, same as /api/assistant/tts)
  → MP3 to agent-files `camera-say/<ts>.mp3` → row in `agent_camera_speak_jobs` (queued).
- **Office PC bridge** polls `GET /api/assistant/internal/camera-bridge` every 7 s with
  `Authorization: Bearer <token>` (token = KV `camera_bridge_token`), claims job,
  **downloads the MP3 to `C:\go2rtc\job.mp3`**, POSTs
  `http://localhost:1984/api/streams?dst=<stream>&src=ffmpeg:C:/go2rtc/job.mp3%23audio=pcma`
  to go2rtc, then POSTs ack `{id, ok, error}`.
- Verified end-to-end 2026-07-03 00:33 (job `0c8eb95a…` played, staff heard it).
- Safety: queued jobs older than **10 minutes auto-expire** (status failed/'expired') —
  an offline bridge never blares stale announcements. Owner route: POST
  `/api/assistant/camera-say` {text, camera} (owner session).
- Cameras/streams: only **workroom** wired in go2rtc config. `resolveStream` maps
  work/workroom/কাজ → workroom, entrance/গেট → entrance, boss/বস → boss (default workroom).

### PRs merged this session
#189 entrance watch · #190 form feedback fix · #191 camera_speak pipeline ·
#192 bridge route under /internal/ · #193 bridge downloads MP3 before playing.

---

## 2. Office PC setup (the bridge machine)

Windows PC in the office, same LAN as the cameras (`Alma Online Shop_5G`, PC = 192.168.1.137).

- `C:\go2rtc\go2rtc.exe` (v1.9.14) + `go2rtc.yaml` + `ffmpeg.exe` (gyan.dev essentials)
  + `bridge.ps1` (from `docs/office-pc-camera-bridge.ps1` on main) + `bridge-token.txt`.
- go2rtc.yaml: stream `workroom` → `rtsp://admin:<device-password>@192.168.1.228:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif`
  and `ffmpeg: bin: C:/go2rtc/ffmpeg.exe` (absolute path is REQUIRED on Windows).
- Auto-start at Windows logon via HKCU Run keys `alma-go2rtc` and `alma-camera-bridge`
  (no admin needed). PC must stay ON and logged in; advise owner to disable sleep.
- go2rtc web UI: http://localhost:1984 (on the office PC only).

### Cameras (all Imou IPC-S2E-5R1S ≈ Ranger 2 Pro — backchannel CONFIRMED on this model)
| Room | Serial/deviceId | LAN IP | go2rtc stream | Device password |
|---|---|---|---|---|
| Work Room -1 | 63EF8BKPSF8DB25 | 192.168.1.228 | workroom ✅ | set by owner 2026-07-02 (owner knows; also in agent memory) |
| Office Entrance Room | 63EF8BKPSFE61E9 | 192.168.1.147 | entrance (NOT yet in go2rtc) | not set yet |
| Boss Office Room | 63EF8BKPSFCB945 | 192.168.1.191 | boss (NOT yet in go2rtc) | not set yet |

Camera facts learned the hard way:
- Local RTSP password = the **Device Password** (Imou Life → camera → Settings →
  Device Password; default claims to be the safety code but the safety code did NOT work —
  owner must SET a device password). TLS Encryption toggle was already off.
- ~5 failed logins → camera locks 30–60 min ("wrong user/pass" even for correct creds);
  reboot from the app (Settings → More → Restart Device) clears it. Never retry-spam.
- The RTSP SDP exposes `audio sendonly (PCMA/PCMU/L16/AAC @8k/16k)` = speaker backchannel,
  and `audio recvonly MPEG4-GENERIC/16000` (AAC 16 kHz) = mic (Whisper-ready for Phase 3).
- go2rtc accepts remote-URL ffmpeg sources **silently without sound** — ALWAYS download
  the MP3 to disk first, then play the local file. "Job acked done" ≠ heard; the bridge
  console line `played job <id>` + a human ear is the truth.

---

## 3. How to operate the owner's machines (READ CAREFULLY)

### Owner's Mac (where Claude runs)
- Full shell access. gh CLI at `~/.local/bin/gh`; authenticate per command:
  `GH_TOKEN=$(printf "protocol=https\nhost=github.com\n" | git credential fill | grep '^password=' | cut -d= -f2)`.
- Chrome MCP: the owner stays logged into production (`alma-erp-six.vercel.app`) —
  owner-session API calls can be made via `javascript_tool` fetch on a prod tab.
- Vercel MCP: team `team_iq0WiA8foX0t7IkFS065L1XP`, project `prj_FHO3TuVxkwnGqTCF4vCH2SFJbHq1`.
- Supabase MCP: prod DB `nrkuzcorcpcwrkckbeoq` (execute_sql works; KV = `agent_kv_settings`).

### Office PC via AnyDesk (computer-use MCP on the Mac)
1. Owner connects AnyDesk from his Mac to the office PC (ID shown in title, e.g. 851 571 519)
   and keeps the window open. Claude requests computer-use access to "AnyDesk" (full tier),
   then drives the remote PC through that window.
2. **Free-tier AnyDesk cuts the session every few minutes** ("Session will be closed…").
   Owner clicks Retry / office staff re-accepts. Downloads/processes on the office PC
   keep running through disconnects.
3. **On re-accept, "Control remote device" permission is sometimes dropped → view-only**
   (clicks/keys silently do nothing). Check AnyDesk menu-bar → Permissions; if
   "(disallowed)", the office side must re-enable input or reconnect with permissions.
4. Keyboard mapping gotchas: Mac `cmd` maps to the **Windows key** (cmd+v = Win+V
   clipboard panel, cmd+l does nothing) — always use `ctrl+…`. `ctrl+t` is unreliable —
   click the address bar directly. Clipboard sync works when the permission is granted:
   write_clipboard on Mac → ctrl+v on remote. For Bangla text into remote consoles,
   pass it as `decodeURIComponent('%E0%A6…')` inside an ASCII-only command.
5. Long commands: type into PowerShell via the `type` action (ASCII only). New PowerShell:
   click taskbar Search → type "powershell" → Enter.
6. Owner suggested setting an AnyDesk **Unattended Access password** on the office PC —
   do this when convenient; it removes the staff-accept dance.

### Owner's rules (from CLAUDE.md + session)
- Reply in **Bangla** (code identifiers stay English). Owner is not an engineer — plain language.
- Act autonomously; merge agent PRs yourself after green build (owner authorization overrides
  CLAUDE.md's no-merge rule). Agent scope only: `src/agent/`, `src/app/api/assistant/`, additive
  migrations, `vercel.json` crons, `docs/`. NEVER touch shared ERP code (e.g. `src/middleware.ts` —
  if middleware blocks a cookie-less route, move the route under `/api/assistant/internal/` instead).
- Browser/hardware proof before claiming done. "API said ok" is not proof — today's lesson.
- Physical steps (app toggles on his phone, logins, AnyDesk accept) belong to the owner —
  ask in one short numbered list, in Bangla.

---

## 4. Where secrets live (never commit them)
- Bridge token: KV `agent_kv_settings.camera_bridge_token` (rotate by updating KV +
  `C:\go2rtc\bridge-token.txt` together). Value never in git.
- Camera device password: owner set it 2026-07-02 (same convention intended for all three
  cameras); recorded in the agent's private memory, not in this repo.
- TTS creds: Vercel env `GOOGLE_TTS_CREDENTIALS`. Imou API: `IMOU_APP_ID/SECRET`.
  Telegram/etc. env vars are **production-scoped** — preview deploys have no Telegram.

---

## 4b. Imou event webhook (BUILT + REGISTERED 2026-07-03 ~01:15, verification pending)

PR #195. The camera's own human/motion detection now drives the entrance watch:
- Receiver: `/api/assistant/internal/imou-event?k=<KV imou_webhook_key>` — ALWAYS
  answers 200 (repeated non-200s make Imou blacklist the URL), lenient body parsing,
  logs `[imou-event] received did=… msgType=…` for every push, acts only on the
  entrance deviceId + msgTypes in KV `imou_event_types`
  (default videoMotion,human,humanDetect,aiHuman,pir — TUNE from real log lines).
- Registration: POST `/api/assistant/known-people/webhook` {enable:true|false}
  (owner session) → Imou `setMessageCallback` (callbackFlag alarm, basePush '1'
  keeps the owner's own app notifications). Registered & accepted 2026-07-03.
- Event path: `runEntranceEvent()` in entrance-watch.ts — no time window (24h),
  20 s min gap between event snapshots, SHARES alert state with the polling cron
  (both can run without double alerts).
- KV switches: `entrance_webhook_enabled` (default on) for the event path;
  `entrance_watch_enabled` for the polling cron.

**Also done cloud-side (2026-07-03 ~02:00): announcement outcome notifications.**
`sweepAndNotifySpeakJobs()` (camera-say.ts, `notified_at` column) tells the owner
exactly once per announcement: "✅ বেজেছে" (seconds after the bridge ack) or
"⚠️ বাজেনি — PC বন্ধ / error" (expired jobs are swept by the 1-min entrance-watch
cron, which runs even when the bridge PC is off). Backfilled old jobs as notified.

---

## SESSION 2026-07-03 UPDATE (steps 1-8 run — read this before the list below)

- **Step 3 DONE+verified:** PC rebooted → go2rtc+bridge auto-started (HKCU Run works); test
  announcement played (bridge console `played job d170caa9…`) + ✅ বেজেছে Telegram.
- **Step 4 entrance DONE+verified:** `docs/office-pc-setup-entrance.ps1` ran on the PC
  (one-shot: probe → yaml → restart → listener). go2rtc streams now `entrance, workroom`;
  entrance test announcement job `9fa5134f` done in 8 s + ✅. **Boss camera PENDING** —
  owner forgot its device password (safety code errored); he resets it at the office, then
  uncomment the boss block in `C:\go2rtc\go2rtc.yaml` (placeholder `REPLACE_BOSS_PASS`).
- **Step 7 (Feature 3) SHIPPED:** PR #200 — `/api/assistant/internal/camera-listen`
  (bridge-token auth; audio→Whisper or JSON {text}; wake word KV `camera_wake_words`
  default "আলমা শোনো,আলমা,alma"; cooldown KV `camera_listen_cooldown_sec` 15;
  kill switch KV `camera_listen_enabled`). Forward → owner Telegram verified live
  (forwarded:true). **Office-PC listener deployed + running** (`C:\go2rtc\camera-listen.ps1`,
  HKCU Run `alma-camera-listen`, entrance mic, 6s chunks, silence-skip at −45 dB) —
  POSTing speech chunks, all 200. Field test (staff says wake word) pending.
- **Steps 1/2 PARKED — Imou webhook does NOT deliver:** receiver + registration verified
  correct (`?diag=1` getMessageCallback: status on, right URL) but 0 real pushes in 3+ h
  despite walk-ins + app notifications. External Imou-cloud issue. **Polling stays ON**
  (do NOT set `entrance_watch_enabled=off` until a real push is seen). Fixability test
  ready: `?fix=1` re-registers with `alarm,deviceStatus` → then power-cycle the entrance
  camera; a deviceStatus push proves delivery works at all.
- Step 5 (AnyDesk unattended pw) DONE by owner 2026-07-03 morning. Step 6 (staff photos) still pending.
- **FINAL STATE (2026-07-03 ~05:20 Dhaka, all verified live):** listener v2 on the PC
  (12 s chunks + highpass/dynaudnorm voice boost on the SENT copy only — silence check
  stays on the raw grab). Server STT domain-prompt bias (KV `camera_listen_stt_prompt`).
  Field test PASSED: staff wake-word sentence transcribed correctly → owner Telegram.
  Hardening (PR #205, all verified in prod): trivial-utterance filter (≥3 letters after
  the wake word — kills the «.» hallucination forwards) + **echo guard** — audio
  transcripts ignored for KV `camera_listen_echo_guard_sec` (60 s) after ANY speak job,
  because the camera mic hears its own speaker (side effect: staff can't call within
  ~60 s after an announcement — tune the KV if that bites). Owner→entrance speaker also
  ear-confirmed. PRs this stretch: #200, #203, #204, #205.

## TOMORROW'S SESSION — exact task list (office PC needed for #3-5)

1. **Verify webhook (no PC needed):** morning, after staff move around — Vercel
   runtime logs, query "imou-event": expect `received did=… msgType=…` lines and an
   entrance Telegram alert. Note the REAL msgType names; tighten KV `imou_event_types`
   (keep human-detection, consider dropping pure videoMotion if noisy).
2. **Flip polling off (no PC needed):** KV `entrance_watch_enabled='off'` →
   webhook-only: 24h coverage, quota ~2-5K/month. Polling window KV stays as
   rollback (`on` + 09:00–22:00).
3. **Office PC on → verify auto-start survived the shutdown:** on Windows logon the
   HKCU Run keys must start go2rtc + bridge. Check http://localhost:1984 and the
   bridge console. Then queue a test announcement → expect BOTH the sound (staff)
   and the new "✅ বেজেছে" Telegram confirmation.
4. **Add entrance + boss cameras to go2rtc** (owner sets their Device Passwords
   first): append two streams to `C:\go2rtc\go2rtc.yaml` (same URL pattern, IPs
   .147/.191), restart go2rtc, test `camera_speak` with camera:"entrance"/"boss".
5. **AnyDesk Unattended Access password** on the office PC (Settings → Security) —
   ends the staff-accept dance for future sessions.
6. Owner adds staff reference photos on /agent/known-people (phone/web, no PC).

---

## 5. Next phase (not started) — pick up here

**Phase 3 — Feature 3: staff talks to the camera → owner's Telegram**
1. Add entrance + boss cameras: owner sets their Device Passwords → add both streams to
   `C:\go2rtc\go2rtc.yaml` (same URL pattern) → restart go2rtc → camera_speak already
   supports `camera: "entrance"|"boss"`.
2. Wake-word listener on the office PC: pull `rtsp://…subtype=0` audio (AAC 16 kHz) with
   ffmpeg, chunk it, run STT (Whisper API or local), detect wake word ("আলমা শোনো"),
   then POST the transcript to a new `/api/assistant/internal/…` route → head → owner
   Telegram; owner's reply → camera_speak. Design the listener as a durable loop like
   bridge.ps1 (or graduate both to a small Node service on the PC).
3. Optional hardening carried over:
   - "✅ বেজে গেছে" confirmation: after camera_speak, poll the job row (done/failed) for
     ~20 s and push the result to the owner (all data already in `agent_camera_speak_jobs`).
   - Staff reference photos for known/stranger split (owner adds via /agent/known-people).

**Verification checklist for any camera change:** queue a test announcement → bridge console
must print `played job …` → a human confirms sound; for entrance watch use the 🧪 button on
/agent/known-people and confirm the Telegram card arrives with a photo.
