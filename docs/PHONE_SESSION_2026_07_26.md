# Phone — the 2026-07-26 session: what happened, what was proven, what is left

Written so nothing here has to be re-derived. The owner tested the console's steps 2–4 live over
one long day; four of his reports had non-obvious causes and one was not a bug. Everything below
is backed by a log line or an experiment, not by reasoning.

Read with `PHONE_SYSTEM_HANDOFF.md` (system state) and `ALMA_PBX_CONSOLE_ROADMAP.md` (plan).

---

## 1. The after-hours rule explained most of what looked broken

`decideInbound()` in `src/agent/lib/phone-routing.ts`:

```
staffFirst = answerMode === 'staff_first' && !known && time.open
if (!time.open && !owner) transferMode = 'ask_first'
```

Office hours default to `10-21`, so **at 21:01 the office is closed**. The owner tested then.
Everything that followed was by design and every bit of it read as breakage:

- no caller tune and no 30-second staff ring — staff-first requires `time.open`
- his browser never rang, so **no caller name/orders on the web and no new call history**; the
  history is per-extension and only fills when a call actually reaches a browser
- the agent asked for his name and reason instead of transferring — that IS `ask_first`

Proof, from the bot's START-RAW purpose on that call:
`ইনকামিং কল — এখন অফিস বন্ধ (সাধারণ অফিস সময় 10-21 টা)`.

**Also: the owner's own number is `known`, so it always gets `ai_first`.** staff-first can never
ring his browser from his own phone. Test from an unknown number, inside office hours.

## 2. Two real transfer bugs

1. **`ask_first` promises a transfer it never makes.** `requestForward()` in
   `worker/scripts/gemini-live-bot.mjs` returns `{ok:true, status:'message_mode'}` without
   transferring, but the model has usually already said "যুক্ত করে দিচ্ছি". The caller waits for
   nothing, and there is no hold music because no transfer ever started — which is exactly why
   the owner reported the hold music missing.
2. **The goodbye detector hangs up on a pending forward.** From the log:
   `g4 tool forward_call(...) -> ok` immediately followed by `g4 hang-up (goodbye spoken)`.
   `finishForward()` fires from the drain loop ~1200 ms after the request, and the goodbye path
   wins the race. The owner heard no farewell, which fits: the detector matches the model's
   transcript. The sibling guard already works — `g3 goodbye inside a question — IGNORED`.

## 3. Asterisk → browser was dead until a restart

Every request Asterisk ORIGINATED toward a WebRTC contact failed:

```
res_pjsip/pjsip_resolver.c: Transport type for target '<host>' is '(null)'
res_pjsip_session.c: Source of transaction state change is TRANSPORT_ERROR
Response 503 · dispo FAILED (dur 0.003)
```

So inbound-to-browser, colleague calls, click-to-call ringing your own browser, and the BYE at
the end of a browser-originated call had **never** worked. Browser→Asterisk (register, dial out,
audio) always worked, which is why the phone looked healthy and why the web UI had never shown a
caller's details.

**Ruled out by direct experiment — do not re-test these:** the gateway's websocket proxy (a
hand-written ws client straight to Asterisk failed identically), stale contacts, `max_contacts`,
client keep-alives, `module unload`+`load` of `res_pjsip_transport_websocket`, `rewrite_contact`,
the endpoint's `transport=` pin, and adding a `wss` transport.

**What fixed it: `asterisk -rx "core restart now"` with the config UNCHANGED.** Proven by diffing
the pre-restart config tarball against the live tree afterwards — the only difference in all of
`/etc/asterisk` was a `callerid=` display name. Afterwards an ARI originate to the browser
reached `state=Ringing`.

`Transport type for target ... is '(null)'` is a **red herring** — it still appears on calls that
work. It cost hours.

## 4. The audio complaint is NOT proven

The call where the owner heard the greeting break up measured
`underruns=1 · cushion=16f · dropped=0` — inside the locked baseline (`≤1 / ≤16f / 0`), and other
calls the same evening measured `underruns=0 · cushion=12f`. **The locked tuning was never
touched and the playout dropped nothing.** The remaining place damage can occur is the wire, and
the only measurement for it is that call's RTP loss/jitter on the quality page. Not yet measured.

## 5. Traps that cost real time

- **The softphone watchdog lies.** `/health` reported `softphone: healthy=true` all day while
  Asterisk could not send to a browser at all, because `checkSoftphoneStack()` only checks that a
  REGISTER can arrive — never that Asterisk can SEND. Worse, its "self-repair" is
  `module unload`+`load`, plausibly what put the transport in the broken state to begin with.
- **`ffmpeg -t 0.25 -i x -af volumedetect` measures the WHOLE file** — `-t` is an output option.
  Read that way, a recording looks like it starts at full volume, which produced a confident and
  completely wrong hold-audio diagnosis. Put `-t`/`-ss` BEFORE `-i` to measure a slice.
- **`npm ci` in `worker/` can leave `node_modules` broken mid-run**, and both pm2 apps then
  crash-loop with `Cannot find module 'dotenv/config'` (`MODULE_NOT_FOUND` in `internal/preload`).
  This took the whole phone system down during a revert. After any worker deploy, verify
  `ls worker/node_modules/dotenv/package.json` and `pm2 ls`.
- **The VPS auto-pulls `main`.** A `git checkout <sha>` there is silently replaced, so a hotfix
  must be merged to main, not just checked out. Keep the box on `main`.
- **`_muteTurn` was reverted (PR #616).** It dropped model audio and only cleared on
  `turnComplete`; any turn without one left the agent silent for the rest of the call. Never hide
  a spoken tool call by dropping audio.
- **Gemini Live can open a session, emit a transcript, and send NO audio.** Seen once:
  `queued=0b`, no `out mime=` line, no error. The 8-second `no bot audio → voicemail` fallback
  then plays the voicemail prompt, which the owner reasonably mistook for the caller tune.
- **`deploy-worker.yml` cannot deploy** — the GitHub runner's egress IP is firewalled at the VPS.
  Deploy by hand; commands are in `PHONE_SYSTEM_HANDOFF.md` §8.

## 6. What shipped this session

`#599` console steps 2–4 · `#605` softphone reconnect + staff-first · `#606` keep-alives, spoken
transfers, two hold tunes, call history · `#610` hold-audio directory parser · `#611`
telephony-grade hold conversion (native `.ulaw`, band-limit before resample) · `#613` hanging up
takes the other leg with it · `#616` revert of `_muteTurn`.

Owner-recorded audio is live in two classes: `alma-hold` (transfer) and `alma-welcome` (caller
tune), each in its own directory with `.wav`/`.sln`/`.ulaw`.
