# ALMA phone system — handoff (state as of 2026-07-26)

Single source of truth for anyone picking this up in a fresh session. Read this first, then
`SELF_HOSTED_SIP_ROADMAP.md` (build history) and `PHONE_VERIFICATION_CHECKLIST.md` (what was
proven vs owner-pending).

---

## 1. What this is

We replaced NGS/EasyPBX (a paid middleman PBX) with our own **Asterisk 20.6** on the VPS.
The owner's SIP trunk is his own account with the upstream provider, so NGS was only ever a
layer on top. Everything below is built, merged to `main`, and running.

**Working today**
- Inbound calls: customer dials the DID → our Asterisk → AI answers in Bangla, with the REAL
  caller-ID (NGS stripped it, which is why "জি বস" owner-recognition was impossible there).
- Call recording (records the bridge, so it survives a transfer), delivered to Telegram as
  playable mp3 + stored in Supabase, 30-day auto-cleanup.
- Voicemail when the AI cannot answer; office-hours routing; ring group with 2 rounds and
  hold music; spam blocklist; press-0-for-human; two forward targets (support vs boss).
- Browser softphone at `/agent/phone`: staff answer real calls in the ERP, with screen-pop
  (caller's orders/dues/recent calls), keypad + DTMF, mute, colleague directory,
  click-to-call. Registration proven end-to-end.
- Registration watchdog, per-call CDR, outcome sweep, concurrency + hourly caps, BD-only
  destination allowlist, SIP port firewall.
- **The PBX console at `/agent/phone-console`** (owner-only, shipped 2026-07-26 in PR #585):
  dashboard, live channels, call log with hangup causes and recordings, audio quality
  including per-call packet loss and jitter, and the line/trunk view. Plan and status:
  `ALMA_PBX_CONSOLE_ROADMAP.md`; what ships vs what has a screen: `PHONE_FEATURES_IN_MAIN.md`.
- **Its settings section** (step 2, same day): forward numbers and ring group, office hours
  and holidays, transfer mode, blocklist, caps, hold-audio upload, the provider's own
  registration table, and an audited history with revert. **Two config planes, and they
  behave differently — know which one you are on:**
  - *App-scoped* values are read by `sip-inbound` while a call is being set up and apply to
    the very next call.
  - *Gateway-scoped* values are read on the VPS. The gateway PULLS
    `GET /api/assistant/internal/phone-config` every `SIP_CONFIG_PULL_SECS` (60) with the
    shared `AGENT_INTERNAL_TOKEN`, and falls back to its own env on any failure — so the
    endpoint being down changes nothing about how calls behave. **It pulls from `APP_URL`,
    which is PRODUCTION**, so gateway-scoped settings cannot be tested on a preview.
  - The call-audio tuning is in NEITHER plane and must stay that way: those values are code
    defaults in git with no remote override, so the approved voice cannot be changed by
    anything reachable over the network. A unit test asserts the pull payload's exact key set.
- **The call audio the owner approved on 2026-07-26 is LOCKED — CLAUDE.md hard rule #1.** Read
  it before touching anything near the playout, the jitter cushion or the VAD.

**Outbound — root cause found 2026-07-25, and it was ours (see §5).** The provider holds ONE
registration binding per account and the last registrant wins it. NGS re-registers every ~60 s;
we were doing it every 300 s, so the line usually belonged to NGS and our INVITEs went out from
an address that was not the current binding — about half of them died. `expiration` is now 60,
and no second PBX may register this account.

---

## 2. Access

| Thing | How |
|---|---|
| VPS | `ssh root@31.97.237.40` (key already on both of the owner's Macs) |
| Repo path on VPS | `/opt/alma-erp` (worker at `/opt/alma-erp/worker`) |
| Services | `pm2 ls` → `alma-agent-worker`, `gemini-live-bot`, `alma-sip-gateway`, `alma-browser-worker` |
| Asterisk CLI | `asterisk -rx "<command>"` |
| ARI | `http://127.0.0.1:8088/ari`, user `alma` (password in VPS `.env` as `ARI_PASS`) |
| Gateway control API | `http://127.0.0.1:8770` (loopback + docker bridge only) and publicly via `https://sip.31-97-237-40.sslip.io` |
| Gateway auth | `Authorization: Bearer $AGENT_INTERNAL_TOKEN`, or the `X-Authorization` + `X-Authorization-Secret` pair |
| Provider panel | `amarip.net` (SIP users, CDR, call limit) — owner's login |
| NGS/EasyPBX panel | `alma-traders.infosoftbd.com` — owner's login, kept for comparison |
| Secrets | ONLY in `/opt/alma-erp/worker/.env` on the VPS. Never in git, never printed to chat. |

**Vercel Production env (all set by the owner, all non-secret):**
`SIP_GATEWAY_BASE=https://sip.31-97-237-40.sslip.io`, `SIP_FORWARD_SUPPORT=01868996666`,
`SIP_FORWARD_BOSS=01779640373`, `VOICE_CALL_PROVIDER=sip`.
**Rollback is one value:** set `VOICE_CALL_PROVIDER=relay`.

---

## 3. Shape of the system

```
customer phone
   ↕ PSTN
provider switch 103.170.231.10:5060        ← we send TO :5060, FROM :5062
   ↕ SIP trunk (endpoint `alma`, transport-alma bound 0.0.0.0:5062)
Asterisk 20.6 on the VPS
   ├── inbound:  from-alma → alma-in → Stasis(alma-sip,inbound,<caller>,<did>)
   ├── staff:    from-staff (internal 1XXX, BD mobiles _01XXXXXXXXX, landlines _0[2-9]X.)
   └── ARI + externalMedia(AudioSocket)
        ↕
   worker/src/voice-relay/sip-gateway-service.mjs   (pm2 `alma-sip-gateway`)
        ├── control API (NGS-shaped) ← Vercel places calls here
        ├── /ws passthrough          ← browser softphone (Traefik terminates TLS)
        └── AudioSocket ↔ μ-law bridge
             ↕
   worker/scripts/gemini-live-bot.mjs  (pm2 `gemini-live-bot`, port 8766)
```

Browser softphone TLS path: `wss://sip.31-97-237-40.sslip.io/ws` → Traefik (existing
Let's Encrypt) → `sipgw-bridge` socat container → gateway `/ws` → Asterisk on loopback.
**Only `/ws` is proxied on purpose** — Asterisk serves `/ari` on the same port, and exposing
that would hand the internet full call control.

**Key files**
- `worker/src/voice-relay/sip-gateway-service.mjs` — the gateway (most of the logic)
- `worker/scripts/gemini-live-bot.mjs` — the AI voice bot (unchanged WS frame contract)
- `worker/deploy/asterisk/*.conf` — trunk, inbound dialplan, WebRTC, firewall script
- `src/app/api/assistant/voice-call/sip-{inbound,cdr,confirm,voicemail}/route.ts`
- `src/app/api/assistant/phone/{credentials,caller,dial}/route.ts`
- `src/agent/components/phone/*` + `src/app/agent/phone/page.tsx`
- `src/agent/lib/voice-call.ts` (`placeSipLiveCall`), `src/agent/lib/ngs-call-outcome.ts`

---

## 4. Self-test harness — USE THIS INSTEAD OF CALLING THE OWNER

Two dialplan contexts exist so audio paths can be proven without dialling a human:

```bash
AP=<ARI_PASS>
# a caller that stays silent
curl -s -u alma:$AP -X POST http://127.0.0.1:8088/ari/channels \
  --data-urlencode "endpoint=Local/09649777738@from-alma" \
  --data-urlencode "context=alma-selftest-park" \
  --data-urlencode "extension=s" --data-urlencode "priority=1" \
  --data-urlencode "callerId=+8801711111111"
# a caller that actually SPEAKS (proves recording/voicemail capture)
#   → same call, but context=alma-selftest-talk
```

Measuring audio quality objectively (this is how the stutter was root-caused): pull the
recording from Supabase and count silence gaps inside speech. The owner's 79 s call had **58
gaps totalling 18.4 s**; the cause was a jitter buffer rebuilding a 120 ms cushion every time
Gemini's audio arrived late.

---

## 5. OUTBOUND — ROOT CAUSE, found 2026-07-25 (everything before this was a symptom)

**The provider keeps exactly ONE registration binding per SIP account, and the last registrant
owns it. We were re-registering every 300 s; NGS re-registers every ~60 s. So whenever both
were configured, NGS owned the line almost all the time — and our outbound INVITEs went out
from an address that was not the current binding.**

Watch their own table (`amarip.net` → SIP Users, or `/api/sip-registrations` behind it, which
returns the row with IP, user agent and seconds remaining):

```
09:19:51  163.227.239.96  NextGenSwitch v1.0.0  exp=35
09:20:21  163.227.239.96  NextGenSwitch v1.0.0  exp=58   <- NGS refreshed
09:22:51  163.227.239.96  NextGenSwitch v1.0.0  exp=15
09:23:21  31.97.237.40    Asterisk PBX 20.6.0   exp=45   <- we took it, after switching to 60s
09:24:21  31.97.237.40    Asterisk PBX 20.6.0   exp=35
```

Calls placed while we did not own that row are the ones that died — `no_route`,
`rate_plan_no_match`, `stale_timeout`, or silence with `481` to our CANCEL. Roughly half of
them, which is exactly what the owner counted (18 of 35).

**A `200 OK` to our REGISTER proves nothing.** Asterisk reported `Registered (exp. 3227s)`
while the provider's table did not list us at all. Our own registration state is not evidence;
only their table is.

**Fix (live on the VPS and in `worker/deploy/asterisk/alma-trunk.conf`):** `expiration=60`,
matching what NGS does. Verified: the binding flipped to us within one cycle and stayed.

**Second rule, equally important:** never let a second PBX register this account. NGS must be
genuinely deactivated — pointing its trunk at a wrong port is not enough, and while its trunk
is healthy it takes the line back every minute.

### Tested and NOT the cause — do not spend a session on these again

Destination format (`01…`, `880…`, `+880…`), operator prefix (013/016/017/018/019 behave
identically), on-net vs off-net, an `"Anonymous"` display name in `From`, and call spacing.
Failing and succeeding INVITEs are byte-for-byte identical apart from the dialled number.

Two readings that looked right and were not, recorded so nobody re-derives them: (1) "the
failures never appear in their CDR" — they do, with causes; (2) "every call within ~80 s of a
re-registration dies" — a clean rerun disproved it. And `expiration=3600`, briefly shipped as
"hygiene", was actively harmful: it meant we claimed the binding once an hour.

### Verified after the fix

Thirty outbound calls with the 60 s binding held throughout: **29 reached the network, 1 died**
(`setup_failure`) — 3%, against 19% (14 of 74) earlier the same day. Of the earlier failures,
every `rate_plan_no_match`, `no_route` and `stale_timeout` disappeared; only the lone
`setup_failure` class remains, and that one is plausibly theirs.

### How to test outbound — DO NOT invent numbers

Earlier in this session the test batches dialled made-up numbers on the assumption they were
unassigned. **That assumption cannot be verified, the calls do ring if the number is live, and
they go out under the owner's own licence.** Owner instruction 2026-07-25: never again.

Use instead:
- **PSTN loopback — dial our OWN DID `09649777738`.** It leaves through the trunk, comes back
  through the provider, and nobody else's phone is involved. It costs two of the trunk's two
  channels, so run it only when the line is idle. Proven working: `183 Session Progress` then
  `200 OK`, and the inbound leg arrives on our own Asterisk.
- **The owner's own number**, when he is expecting it.
- **Passive**: read the provider's CDR (filter CLIENT IP `31.97.237.40`) and count hangup
  causes on the real business traffic. No calls placed at all, and it is the honest measure.

---

## 5b. Earlier reading of the same problem (kept for the packet evidence)

Packet capture on 2026-07-25 12:38:54 Dhaka, `tcpdump host 103.170.231.10`:

```
12:38:54.29  us   → INVITE sip:01779640373@103.170.231.10:5060
12:38:54.56  them → 100 Trying
12:38:54.56  them → 401 Unauthorized
12:38:54.56  us   → INVITE (with Digest auth)
             …100 seconds, not a single packet back…
             channel stayed "Down" the whole time — never rang
```

An earlier call, when we finally sent CANCEL, was answered with
**`481 Call/Transaction Does Not Exist`** — their switch had no record of it. That is why
these calls **do not appear in the provider's CDR** and why the owner's phone never rings.

**Ruled out, each by test:**
- Our config changed — diffed against pre-work backups; the trunk endpoint/transport/auth are
  untouched, and failures predate today's work (owner's own report: 18 of 35 failed since
  yesterday).
- Caller-ID — changing `from_user` to `2323` (what NGS's CDR shows) changed the failure mode
  from silence to an immediate reject in 3.7 s, proving their switch inspects it, but 2323 is
  an NGS-internal id and is not valid on the wire. **Reverted to 09649777738.**
- Late delivery — disproven by the 100-second wait above. Raising our ring timeout would NOT
  help.
- Port — the panel shows `31.97.237.40:5062`, which is our SOURCE port and is correct; the
  destination is `:5060`. **`5061` is a FAKE port the owner deliberately configured inside
  NGS to keep NGS disabled — never point our trunk at it.**

**Suspicion still open:** the SIP user shows **CALL LIMIT = 2** on amarip.net, while the NGS
trunk shows limit 0. A transfer alone consumes two legs. The gateway's own cap is
`SIP_MAX_CONCURRENT_CALLS` (currently **4** — should be lowered to 2, owner has not yet
approved).

**What the owner is doing:** he has the packet trace and is with provider support.

---

## 6. Traps already paid for — do not rediscover these

1. **`chan_sip` hijacks the "sip" websocket subprotocol** — softphone registrations were
   validated against its empty user list ("Wrong password" for a correct password). Now
   `noload`ed. It also owned UDP 5060, which is what the port scanners were reaching.
   **This regressed on 2026-07-25** and cost a second diagnosis, so read the whole trap:
   - `noload => chan_sip.so` is honoured **only inside the `[modules]` section**. Appended at
     the end of `modules.conf` it lands in `[global]` and is silently ignored. The line is now
     under `autoload=yes`, and `worker/deploy/asterisk/alma-modules.conf` is the copy of record.
   - The first fix had only been applied at runtime (`module unload`), so an **unattended apt
     upgrade restarted Asterisk at 06:26 and brought chan_sip straight back**.
   - The victim module is `res_pjsip_transport_websocket`: it ends up loaded but **`Not
     Running`**, because it could not claim a subprotocol chan_sip already held. Unloading
     chan_sip is not enough — that module needs `module unload` + `module load` to grab it.
   - **The failure is silent.** The trunk stays registered and inbound AI calls keep working;
     the only symptom is staff unable to log in at `/agent/phone`. The gateway now checks this
     every `SIP_WS_CHECK_SECS` (300) and self-repairs when no call is in progress.
   - To identify which module owns the subprotocol without a real password: send a REGISTER
     over `ws://127.0.0.1:8088/ws` with a bogus digest and read the log — `chan_sip.c: …Wrong
     password` means chan_sip owns it, `res_pjsip/pjsip_distributor.c: …Failed to authenticate`
     means pjsip does.
2. **An AOR must be named EXACTLY as the extension** — pjsip's registrar matches the To-header
   user against the AOR *name*; `<ext>-aor` answers 404 even though the AOR exists.
3. **Deleting the externalMedia channel closes its AudioSocket, and that close handler used to
   hang up the call** — it killed voicemail mid-prompt and killed the parent call the instant a
   transfer dialled. Both paths are excluded now.
4. **Playing to a bridged CHANNEL yields no PlaybackFinished**, and taking the channel out of
   the bridge (delete OR removeChannel) ejects it from Stasis into the dialplan's Hangup. Keep
   voicemail prompt + recording **bridge-scoped**.
5. **`/var/spool/asterisk/recording` must exist** or ARI recording 500s.
6. **ARI originate `timeout` defaults to 30 s** and cancels silently — the owner reached his
   phone at ~30 s and got the carrier's "busy" announcement. Now `SIP_RING_TIMEOUT=45`.
7. **The bot posts transfer XML form-encoded as `responseXml`** — a regex over the raw body
   finds nothing, so every transfer silently failed until the gateway decoded it.
8. **`src/middleware.ts` exempts each voice route by EXACT pathname** — a new route 401s until
   it is listed there.
9. **Telegram will not play an 8 kHz mp3** — it shows the right duration and plays silence.
   Resample to 44.1 kHz.
10. **The BD mobile pattern is ELEVEN digits** (`_01XXXXXXXXX`). A ten-X pattern matches
    nothing anyone would dial.
11. **Any unsupported field in the Gemini Live `connect()` config kills the whole session** —
    `inputAudioTranscription.languageCodes` exists in the SDK but the Developer API rejects it,
    and every call went silent. One config change per live call.
12. **qualify OFF for WebRTC AORs** — a browser that misses an OPTIONS poll is marked
    Unavailable and Asterisk then refuses to dial it.
13. **An unattended apt upgrade will restart Asterisk mid-day** — on 2026-07-25 an rsyslog +
    libpam upgrade (not Asterisk itself) restarted it at 12:26 Dhaka, dropping calls and
    reloading `modules.conf`. `needrestart` is now told never to restart `asterisk.service`
    (`/etc/needrestart/conf.d/50-alma-phone.conf`) and the apt timers were moved to ~03:00
    Dhaka. A library fix therefore needs a human restart at a quiet hour.
14. **The log directory reached 21 GB, and 99% of it was one SIP brute-force flood** on
    2026-07-24 (39,605 failed REGISTERs from 163.172.111.53 alone) that hammered UDP 5060
    before the firewall was in place. Real traffic writes almost nothing — measured 0 bytes in
    60 s on an idle line. Rotation is now daily + compressed + 500 MB per file, and the old
    files are gzipped: 21 GB → 537 MB.
16. **A new music-on-hold class does not load on a reload.** `moh reload` and
    `module reload res_musiconhold.so` both report success and both leave the class missing
    from `moh show classes`. Only `module unload` + `module load` picks it up — do it while the
    line is idle, since unloading MOH mid-call cuts the music a caller is listening to.
17. **`Local/<did>@from-alma` is NOT a PSTN loopback.** `from-alma` is the INBOUND context, so
    the call is answered inside our own Asterisk and never touches the provider — a 70-second
    "loopback" produced ZERO RTP packets on eth0. It is a simulated inbound caller, useful for
    that and nothing else. A real loopback is placed through the gateway's
    `POST /api/v1/call` to our own DID `09649777738`, and it occupies BOTH channels of a
    two-channel trunk, so loss/jitter figures from one are not an ordinary call's figures.
18. **A recording can never contain what the network did.** ARI records the BRIDGE, inside
    Asterisk, before the audio goes on the wire. That is why a recording can sound clean while
    the call did not, and why handing the file to a model to "listen for the problem" cannot
    locate a cause. The numbers that do contain it are Asterisk's own RTP counters
    (`pjsip show channelstats`), now sampled every 10 s per call and stored on the CDR.
19. **The end of a sentence is not an underrun.** The bot delivers audio every 21 ms while the
    model speaks (p99 24 ms) and then stops for 1.7–2.5 s between turns, so the playout queue
    empties at the end of EVERY turn. Counting that as a dry-out ratcheted the jitter cushion
    12 → 32 frames and never released it, adding ~0.5 s of delay to every later reply.
    `SIP_TURN_END_MS` (60 ms) tells the two apart. Do not remove it.
20. **The agent must not hang up on the boss.** The goodbye detector fired on
    "আর কিছু লাগবে বস, নাকি কলটা রাখব? আল্লাহ হাফেজ।" — a question with a farewell attached.
    A farewell inside a question is now ignored on every call, and on an owner call nothing
    arms the hang-up until the caller has asked to finish. The prompt had forbidden this since
    2026-07-24 and the model did it anyway: for this class of failure the guarantee belongs in
    code, not in an instruction.
15. **A dead second trunk was in `pjsip.conf` the whole time** — `amberit` (202.4.97.37, user
    1098173), pre-dating this work, retrying a REGISTER that never got an answer. Removed
    2026-07-25. It cost nothing but noise; it was not related to the outbound problem.

---

## 7. Working agreements with the owner

- **Never change audio without his ear.** Simulated-call metrics improved while his real
  experience got worse; one change → one call → his verdict. A change he calls worse gets
  reverted immediately.
- **Diagnose before changing anything on the live line.** Two theories (caller-ID, late
  delivery) were disproven by experiment before shipping a "fix" for them.
- **iOS: tell him BEFORE any iOS work** — build, simulator, TestFlight, even waiting on an iOS
  CI check. He must not discover it from a status line.
- Reply to him in Bangla; code, commits and docs in English.
- He merges or explicitly approves merges; CI must be green (the `build-simulator` check is
  iOS-only and irrelevant to web/worker changes, but say so rather than merging past it).
- Secrets never printed to chat or written into files that leave the VPS.

---

## 8. Next steps, in order

**0. (2026-07-26) The console's Phase 2 — settings without SSH — is BUILT.** Two things are
owner-pending before it is fully live, and neither is optional:

  a. **Deploy the worker** (manual dispatch: `gh workflow run deploy-worker.yml`). Until the
     gateway on the VPS runs the new code, gateway-scoped settings save in the ERP and never
     arrive — the settings screen will show "এখনো একবারও নেয়নি", which is the truth.
  b. **Verify on a real call after the merge.** Change one gateway-scoped value (ring rounds
     is the safest), wait a minute, place a PSTN loopback to our own DID `09649777738`, and
     confirm the hangup counters still match the locked baseline: `underruns ≤ 1 · cushion ≤
     16f · dropped = 0`. Nothing in step 2 touches the playout or the VAD, so those numbers
     must be unchanged; if they are not, something else moved and it needs finding.

  Phase 3 (extensions) is next. It writes to the VPS far more than step 2 does — build on the
  config pull rather than adding a push path.

1. **Owner + provider**: one precise question now, not a vague complaint — why does a fresh
   REGISTER take ~100 s to become routable? (§5 has the wording and the numbers.)
2. **Worth building**: an outbound canary — dial an unassigned number on a schedule, expect a
   `18x`, alert when the answer is silence. It would have caught this class of failure on day
   one, and it measures whether the provider ever fixes their side.
3. `SIP_MAX_CONCURRENT_CALLS` is **2**, matching the trunk's call limit. Done.
3. ~~Waiting on owner's hold audio~~ — **done 2026-07-25.** His recording is live as
   `alma-hold` (8 kHz mono `.wav` + `.sln`, 14.6 s, RMS 0.14), `SIP_MOH_CLASS=alma-hold`,
   proven on the line: the ARI moh POST returns 204 and a recorded bridge shows sustained
   audio through exactly that window. Config of record:
   `worker/deploy/asterisk/alma-musiconhold.conf`.
4. **Owner eye-check**: the new phone UI at `/agent/phone` (PR #572) — keypad, mute, speaker,
   screen-pop. Not yet visually verified by anyone.
5. **Still owner-pending** from the checklist: a real mic-to-mic browser call, the
   human-to-human bridge after a transfer, and one live angry-customer escalation.
6. **Deliberately deferred**: AI live in-ear coaching (needs a second listen-only audio leg,
   about a day), queue + hold music for concurrent callers, post-call survey, a second SIP
   trunk for failover.
7. **Known and accepted**: a faint residual audio artefact (the measured causes are fixed; the
   owner called it not a big deal), and transcripts occasionally rendering Bangla as Hindi
   (pinning the language needs Vertex/Enterprise mode; the model always understood correctly).
