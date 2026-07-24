# Self-Hosted SIP Stack — NGS Replacement

## LIVE FINDINGS from the NGS/EasyPBX panel (2026-07-25, inspected in owner's Chrome)

NGS = **EasyPBX** (infosoftbd), a Laravel PBX. Full config seen:
- **Trunk "ALMA AI"**: register to `103.170.231.10:5060` udp, user `09649777738` + password,
  **Peer=Yes** (register + peer host). Call limit unlimited. **Status: Registered, UA
  SIGNAL/1.0, re-registers every ~60s.** ⇒ trivial to replicate; single-account so only
  ONE registrant wins → migration is a **clean cutover**, not parallel.
- **License**: Max Calls 100, Lifetime. (concurrency headroom known.)
- **Inbound Route "Call In"**: DID 09649777738, any CID → **CUSTOM FUNCTION → "Answer URL"**.
- **"Answer URL" custom function** (Applications → Custom Functions): body =
  `https://alma-erp-six.vercel.app/api/assistant/voice-call/ngs-inbound?k=<secret>` —
  **THE root cause: no caller variable.** NGS fetches this on every inbound call.
- **Path-1 band-aid test FAILED**: appended 12 candidate caller variables (`{caller}`,
  `{{caller}}`, `{cid}`, `{caller_id}`, `{from}`, `{event_from}`, `{callerid}` in both
  brace styles) to the Answer URL. On a live call our webhook received **only `k`** — NGS
  template-stripped ALL 12 (engine ran, recognized none). So the correct variable exists
  but is undocumented; discovering it = **one support message to the provider** ("which
  template variable passes the caller number to a custom answer URL?"), not guesswork.
- The DID **09649777738 is the owner's own trunk account** — it stays with us on migration.

## FULL NGS CONFIG SNAPSHOT (copied from panel 2026-07-25 — everything to replicate)
This is the COMPLETE EasyPBX config; nothing else is needed to rebuild it on our Asterisk.
- **Trunk (id 31 "ALMA AI")**: type=register+peer (Peer=Yes); registrar/host `103.170.231.10`
  port `5060` transport `udp`; auth user `09649777738`, password in VPS `.env` (SIP_PASS);
  call limit unlimited; INVITE auth realm observed = `semux.io` with `qop="auth"` (Asterisk
  pjsip handles automatically). Registrar re-registers ~every 60s (must run persistent).
- **Outbound route (id 30 "Out")**: priority 1 → trunk 31; dial patterns start-with `01`
  and `880`; recording off. (Asterisk dialplan: `_01.`/`_880.` → Dial(PJSIP/${EXTEN}@trunk).)
- **Inbound route (id 25 "Call In")**: DID pattern `09649777738`, any CID → CUSTOM FUNCTION
  → "Answer URL".
- **Answer URL custom function (id 16)**: `GET https://alma-erp-six.vercel.app/api/assistant/
  voice-call/ngs-inbound?k=<NGS_INBOUND_SECRET>` — returns our `<response><connect><stream>`
  XML. (Self-host: our sip-inbound route returns JSON params; caller-ID comes from SIP From.)
- **License**: Max Calls 100, Lifetime. Codec/DTMF not exposed (EasyPBX defaults = ulaw +
  RFC2833) — Asterisk default ulaw + rfc2833 matches.
- Media transport to the bot = NGS's own WS Media-Streams dialect (μ-law 8k `start/media/stop`);
  self-host replaces this with Asterisk AudioSocket → the same bot frame contract via the shim.

## PROOF STATUS (honest, 2026-07-25) — for the owner's go/no-go
✅ VPS→trunk REGISTER 200 OK (no BD IP-lock). ✅ number is the owner's own account.
✅ trunk/routes/answer-URL fully captured (above) — replication is turnkey.
⏳ NOT yet proven end-to-end: a real 2-way call THROUGH our own stack — because that requires
   Asterisk installed (Phase 1). Nothing found blocks it; the qop/proxy INVITE auth that broke
   the raw-Node probe is exactly what Asterisk does for free. The 100% "it works" proof IS the
   first Asterisk call. Recommendation: build Phase 1 (outbound) behind the flag with NGS as
   fallback — that call is the proof; if anything surprises us, revert by one env var.

## Owner's decision goal (2026-07-25): STOP paying NGS monthly; self-host everything.
Also wants **multiple numbers**: one DID → boss's AI, a second DID → staff/support forward.
Self-hosted Asterisk does multi-DID routing trivially (each inbound route its own dialplan)
— removes NGS's single-forward-number limit. (Needs the provider to add a 2nd DID to the
trunk — a provider request, separate from the build.)

## Two next-step paths
- **Path A (band-aid, stay on NGS)**: get the caller-variable name from the provider, put
  it in the Answer URL → owner-recognition works with ZERO code/infra change. Cheapest, but
  keeps the monthly NGS fee + single-forward limit. Blocked on a provider reply.
- **Path B (owner's real goal)**: self-host Asterisk (below), drop NGS, own caller-ID from
  SIP From, multi-number. Bigger build; the phased plan below stands.

## Context

Owner (2026-07-25): NGS is just a middleman — he personally holds the SIP trunk
credentials (host 202.4.97.37:8190, user+pass). Can we cut NGS out and run calling on
our own system?

Driving pain: NGS's inbound webhook does NOT deliver the caller's number (proven live
— payload carries only our `k` secret), which breaks owner-recognition ("জি বস" mode)
→ wrong persona → premature hangups. NGS is a black box we can't fix. Self-hosting
puts caller-ID in the SIP INVITE `From:` header — permanently under our control.

Verified groundwork: the Gemini Live bot (`worker/scripts/gemini-live-bot.mjs`) is a
complete two-way AI phone brain behind a clean transport contract (WS frames
`start`/`media`/`stop` in, `media`/`clear` out, μ-law 8k, HMAC start-auth). A
Milestone-1 pure-Node PoC (`worker/src/voice-relay/sip-gateway.mjs`) already proved
REGISTER + digest auth + outbound INVITE + RTP μ-law against this very trunk. μ-law
decode exists (`muLawToPcm16` in `worker/src/voice-relay/sarvam-media.mjs`).

## Engine decision: **Asterisk + ARI + AudioSocket** (on the existing VPS)

- AudioSocket = 3-byte header + raw PCM over TCP → the bot-bridge shim is ~200 lines
  of Node reusing our existing μ-law codecs; the shim owns the playback queue so the
  bot's `clear` (barge-in) maps exactly to "flush queue".
- ARI is already REST (POST/DELETE/GET on channels) → mirrors the NGS API shape, so
  app-side changes stay minimal.
- Stock `apt install asterisk` (no compiling — unlike FreeSWITCH's mod_audio_stream);
  battle-tested SIP/RTP/NAT vs growing the PoC into a production stack for a live line.
- Node keeps the smart parts; Asterisk does only SIP/RTP.

```
Phone ⇄ BD trunk ⇄ Asterisk (pjsip, firewalled to trunk IP)
                     ⇅ AudioSocket TCP 127.0.0.1 (slin 8k)
                     ⇅ ARI 127.0.0.1:8088
   sip-gateway-service.mjs (pm2) — shim + NGS-shaped control API 127.0.0.1:8767
                     ⇅ ws://127.0.0.1:8766/ws  (bot contract UNCHANGED)
   gemini-live-bot.mjs — unchanged except optional per-call `ctrl` base URL
```

## Phases (each shippable; NGS stays as fallback via `VOICE_CALL_PROVIDER` flag)

### Phase 0 — Probes (S) — GO/NO-GO GATE — **PARTIALLY DONE 2026-07-25**
✅ **Probe 1 PASSED LIVE**: REGISTER from the VPS (31.97.237.40) to the trunk
   `103.170.231.10:5060` (NOT the PoC's old 202.4.97.37) with the owner's creds →
   401 challenge → digest auth → **200 OK**, clean de-register. NO BD IP-lock.
✅ **Finding**: the SIP user IS the DID (09649777738) — the number is the OWNER'S
   trunk account, not NGS property. The number survives the migration.
   (Creds live only in the VPS env — never in git.)
Remaining before Phase 1 flips anything:
2. Outbound INVITE probe → owner's phone rings, greeting audible (RTP-out proven —
   extend `worker/scripts/sip-probe.mjs` from the PoC)
3. Inbound probe: while registered, owner calls the DID → log INVITE: caller number
   in `From:`? inbound RTP arrives? (brief NGS-inbound disruption window — run at
   night with the owner's go, de-register right after)
4. Owner asks provider: concurrent-channel limit
Rollback: nothing touched.

### Phase 1 — Outbound via SIP (`VOICE_CALL_PROVIDER='sip'`) (L)
- VPS one-time: `apt install asterisk`; configs checked into `worker/deploy/asterisk/`
  (pjsip.conf trunk, extensions.conf, ari.conf, http.conf, rtp.conf 10000-10200);
  ufw: 5060/RTP only from trunk IP; ARI/AudioSocket/control API bind 127.0.0.1.
- NEW `worker/src/voice-relay/sip-gateway-service.mjs` (pm2): ARI Stasis app +
  AudioSocket server (slin⇄μ-law via existing codecs; 20ms pacing; `clear`→flush) +
  HTTP control API mirroring NGS: `POST/DELETE/GET/PUT /api/v1/call[/{id}]`, same
  `X-Authorization` header names (new SIP_GATEWAY_KEY/SECRET); PUT parses the bot's
  existing `<Dial>` XML.
- MODIFY `src/agent/lib/voice-call.ts`: add `'sip'` provider + `placeSipLiveCall`
  (near-copy of `placeNgsLiveCall` :756-820, JSON body instead of XML), row
  `provider:'sip'`, `callSid`=ARI channel id.
- MODIFY `worker/scripts/gemini-live-bot.mjs`: optional `ctrl` param in start frame →
  used for DELETE-hangup (~:408) and PUT-transfer (~:537). Backward-compatible.
- NEW `worker/scripts/sip-glive-call.mjs` test trigger + `worker/deploy/README-sip-ops.md`
  runbook (owner-readable restart/health commands).
Verify: test call end-to-end (ring → two-way Bangla → barge-in → clean hangup → DB row
completed → report delivered) while prod default stays `ngs`; then flip the flag.
Rollback: `VOICE_CALL_PROVIDER=ngs` (env only).

### Phase 2 — Inbound: the caller-ID win (M)
- NEW `src/app/api/assistant/voice-call/sip-inbound/route.ts` — port of
  `ngs-inbound/route.ts` returning JSON params instead of XML; reuses its
  owner-recognition (`isOwnerNumber`), personas, `transferMode`, row creation —
  finally fed a REAL caller number.
- MODIFY gateway (inbound Stasis handler) + extensions.conf inbound context.
- Number strategy (UPDATED after probe): the DID 09649777738 is the owner's OWN trunk
  account — the SAME number moves with us. Parallel-run window still applies (NGS
  keeps serving it until we flip inbound), but no number migration/publishing needed.
Verify: owner calls DID → greeted as Boss (the whole point); unknown number →
receptionist + transfer works (ARI bridge with bot-fallback = answerOnBridge parity).
Rollback: NGS number keeps ringing regardless.

### Phase 3 — Parity + retire NGS (M)
- MODIFY `src/agent/lib/ngs-call-outcome.ts` + `src/app/api/cron/ngs-call-sweep/route.ts`
  to also sweep provider 'sip' via the gateway GET.
- MODIFY `worker/src/notify/twilio-call.mjs` one-way `<Play>` path → gateway/ARI play.
- Gateway: MAX_CONCURRENT cap (from Phase-0 answer), per-call CDR log.
- After 2-4 weeks of clean `sip` default: drop ~12 NGS_* env vars, stop NGS
  subscription, deprecate NGS routes.
Rollback: env flag until the final retire step.

## Out of scope / unchanged
- WhatsApp call leg stays on Twilio.
- Bot personas/tools/report path/`agent_voice_calls` schema/sweep logic all reused.

## Risks
| Risk | Mitigation |
|---|---|
| ~~Trunk IP-locked to BD~~ | **RESOLVED: REGISTER 200 OK from VPS, live-proven 2026-07-25** |
| ~~Losing 09649777738~~ | **RESOLVED: DID = owner's own trunk account, number stays** |
| Registration conflict with NGS during parallel run | Trunk may fork or replace bindings — inbound flip (Phase 2) is the moment we hold the registration permanently; before that, probes register briefly + de-register |
| Concurrent-call limit unknown | Provider question in Phase 0; gateway enforces cap |
| Audio jitter on VPS | Asterisk jitterbuffer; table-lookup transcoding; 20ms pacing as in PoC |
| SIP scanners | 5060 firewalled to trunk IP; everything else on 127.0.0.1 |
| Non-engineer maintenance | apt packages; static repo configs; pm2; ops runbook |

## Verification summary
Phase 0 probes are themselves the verification gate. Each later phase ends with a live
call test (owner's phone) + DB row + report check, with NGS fallback one env var away.
Deploys: Vercel (routes) + manual worker deploy + one-time VPS Asterisk setup.
