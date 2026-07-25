# ALMA phone system — handoff (state as of 2026-07-25)

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

**Outbound — was failing ~half the time; root cause found 2026-07-25 (see §5).**
The provider's switch needs ~100 s after each REGISTER before it routes our outbound calls,
and we were re-registering every 5 minutes. `expiration` is now 3600, which cuts the exposure
from ~45% of calls to ~2.8%. The residual window is the provider's to explain.

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

## 5. OUTBOUND — root cause found 2026-07-25 (supersedes the "provider-side, nothing we can
## do" reading below, which was half right)

**The failure is time-windowed, and the window is created by OUR registration cycle.**

Twenty identical test calls to unassigned numbers (nobody's phone rings), each with a full
packet capture, sorted by how long ago the trunk had re-registered:

| time since REGISTER | result |
|---|---|
| 0–80 s | **8 of 8 calls died** — `100 Trying`, then silence; `CANCEL` → `481` |
| 100 s+ | **12 of 12 reached `183 Session Progress`** |

The provider's switch needs about **100 seconds after each REGISTER** before it will route our
outbound calls. Inside that window their edge still answers `100 Trying` and then swallows the
INVITE — the call is never created on their core, which is why it appears in **no CDR** and the
callee's phone never rings. That part is genuinely theirs to fix.

Our half: `expiration=300` meant we re-registered **every 5 minutes**, so ~100 s in every 300
was dead — about **one call in two**, matching the owner's own count (18 of 35). Raising it to
`expiration=3600` (the provider grants 3600 — verified in their `200 OK`) leaves one dead
window per hour: **~2.8%**. Live on the VPS and in `worker/deploy/asterisk/alma-trunk.conf`.

Two things follow that are easy to trip over:
- **A reload of `res_pjsip_outbound_registration` re-registers, and so opens a fresh ~100 s
  hole.** Never do it during business hours as a casual "let me refresh things".
- `pjsip send register <name>` sends **`Expires: 0` first** — it de-registers, then registers.
  Running it "to check" takes the line down for a moment; the trunk was left `Unregistered`
  that way during this very investigation.

Hypotheses that were tested and are NOT the cause: destination number format (`01…` vs `880…`
vs `+880…` — all four operator prefixes behave identically), on-net vs off-net, an
`"Anonymous"` display name in `From`, call spacing (three calls 40 s apart all failed inside a
bad window), and the call-limit-of-2 theory. The INVITEs that fail and the INVITEs that succeed
are byte-for-byte identical apart from the dialled number — only the *timing* differs.

**What to tell the provider** (precise, not "outbound sometimes fails"): *for roughly 100
seconds after each successful REGISTER, INVITEs from 31.97.237.40:5062 are answered `100
Trying` and then dropped; a CANCEL is answered `481 Call/Transaction Does Not Exist`. Captures
available. Why does the binding take ~100 s to become routable?*

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

1. **Owner + provider**: one precise question now, not a vague complaint — why does a fresh
   REGISTER take ~100 s to become routable? (§5 has the wording and the numbers.)
2. **Worth building**: an outbound canary — dial an unassigned number on a schedule, expect a
   `18x`, alert when the answer is silence. It would have caught this class of failure on day
   one, and it measures whether the provider ever fixes their side.
3. `SIP_MAX_CONCURRENT_CALLS` is **2**, matching the trunk's call limit. Done.
3. **Waiting on owner's file**: his recorded hold audio → drop into `/var/lib/asterisk/moh-alma`
   on the VPS and set `SIP_MOH_CLASS=alma-hold`. (Bangla script already given to him.)
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
