# PA-5 — Mid-Call Outbound ("call-the-other-guy-while-boss-holds")

**Status: RESEARCH / ARCHITECTURE — no code yet (owner rule: doc + cost guard
first).** Written 2026-07-24 from live NGS docs + our proven integration
surface. Companion phases PA-1..PA-4 are shipped (see memory
`project_phone_agent_roadmap`).

## 1. The ask

During a live call the boss says "X-কে কল করে জিজ্ঞেস করো দাম কত, তারপর আমাকে
বলো" — the agent must place a SECOND outbound call mid-conversation, talk to
the third party, come back, and report — without dropping the boss.

## 2. What the carriers actually support (researched 2026-07-24)

### NextGenSwitch (NGS / infosoftbd — our PSTN + inbound provider)
- Verb set (programmable-voice-api docs): `Say, Play, Gather, Dial, Record,
  Stream, Hangup, Pause, Redirect, Bridge, Leave`.
- **No `Conference` verb, no `Hold` verb.** True 3-way conference is NOT
  available — documented limitation, do not promise it to the owner.
- **`<Bridge bridgeAfterEstablish="true">CALL_ID</Bridge>`** — bridges the
  active call with another in-progress call by call id. This is the primitive
  for "connect boss directly to X" (hand-off, not 3-way: once bridged the bot
  leaves the audio path — same as today's `forward_call` quiesce rule).
- Live-modify PUT `/api/v1/call/{id}` with `responseXml` — battle-proven by
  `forward_call` (Dial + `<Connect><Stream>` fallback chain re-attaches a
  FRESH Gemini session when the dial fails). DELETE `/api/v1/call/{id}` =
  hangup. Origination: POST with `to/from/responseXml/statusCallback`.

### Twilio (WhatsApp leg)
- The boss's WhatsApp calls ride Twilio `<Connect><Stream>` → our relay →
  glive bot. Twilio DOES have `<Conference>` + hold, but ONLY the boss's leg
  lives on Twilio; the third party would be dialed via NGS (BD PSTN rates).
  Cross-carrier conference would force BOTH legs onto Twilio (expensive BD
  PSTN) — rejected on cost.

## 3. Chosen architecture: **two parallel Gemini Live sessions, bot relays**

Key insight: we do NOT need hold music or a conference. The boss's leg simply
STAYS connected to bot session 1 the whole time. "Hold" = the bot says
"ধরে রাখুন বস, কল করছি" and keeps the line; the boss can even keep talking to
it. Meanwhile a second, independent NGS call (leg B) runs its own Gemini Live
session with the contact/staff persona.

```
Boss ──(WA/Twilio or NGS)── glive session 1 (owner persona)
                                   │  new fn: call_third_party(number, brief)
                                   ▼
                            POST /api/assistant/voice-call/midcall-outbound
                            (auth + guards, places leg B via placeOutboundCall
                             machinery: NGS POST → <Connect><Stream>)
                                   │
Third party ──(NGS PSTN)── glive session 2 (contact persona, purpose=brief)
                                   │ session 2 ends → summary (existing
                                   ▼ relay-report path, tagged parentCallId)
                            session 1 polls fn get_midcall_result(id)
                                   │
Boss hears: "বস, উনি বললেন — …"  ◄┘
```

- **Session 1 keeps the boss.** No PUT on leg A at all → zero risk of the
  2026-07-23 forward-audio-mess class. If the boss hangs up while leg B runs,
  leg B finishes and the result lands as a normal call report (Telegram/app).
- **Leg B = a normal `placeOutboundCall`** (callType contact/staff,
  `parentCallId` = leg A's record) — inherits kill switch, daily cap, personas,
  post-call summary, cost logging. New DB columns only: `parentCallId`,
  `midcallResult`.
- **Result hand-back:** session 2's summary is written on the leg-B call row;
  bot session 1 polls `get_midcall_result` (erp-tool bridge, read-only) every
  ~10s and speaks the summary. No new realtime plumbing.
- **Optional direct hand-off (phase 2 of PA-5):** boss says "আমাকে ধরিয়ে দাও"
  → PUT leg A `<Bridge>legB_call_id</Bridge>` + session 1 quiesce (reuse the
  proven quiesceAfterTransfer). 3-way stays impossible (no Conference) —
  bot exits when bridging.

## 4. Cost guard (build BEFORE the feature, per owner rule)

Running rates observed: glive ≈ ৳2-3/min/session (GLIVE_WA_COST_PER_MIN_BDT),
NGS PSTN leg per-minute carrier rate, and DOUBLE Gemini Live burn while both
sessions run.

- `midcall_outbound_enabled` KV — default **OFF** (owner flips).
- Confirm-before-dial: session 1 must repeat number + message and get the
  boss's verbal "হ্যাঁ" before calling `call_third_party` (prompt rule, same
  repeat-confirm pattern as submit_boss_instruction).
- Hard caps: leg B `GLIVE_MAX_MIN`-style ceiling **4 min** (own env),
  **one live leg B per call**, **daily cap 5** mid-call outbounds
  (`midcall_outbound_daily_cap` KV), counted like PA-2's Dhaka-day cap.
- Failure honesty: leg B no-answer/busy → session 1 says exactly that; no
  retry without the boss asking.

## 5. What must be VERIFIED live before coding (unknowns)

1. NGS `<Bridge>` semantics against two REAL calls (does the bridged pair
   survive session-1 ws close? what does the non-bridged side hear on ring?).
   → probe script on VPS, 2 test numbers, before phase-2 hand-off work.
2. Whether our NGS account allows two SIMULTANEOUS outbound calls (trunk
   concurrency) — probe: place two parallel test calls.
3. glive bot capacity: two concurrent sessions is normal (it's a ws server,
   `seq` ids already isolate calls) — but confirm CPU/latency on the VPS with
   two live Gemini sessions at once.

## 6. Build plan (next session, after owner approves this doc)

1. Migration: `parent_call_id`, `midcall_result` on `agent_voice_calls`.
2. Route `/api/assistant/voice-call/midcall-outbound` (internal-token +
   owner-call gate, mirrors submit-instruction) + `get_midcall_result` in the
   erp-tool read allowlist.
3. Bot: `call_third_party` + `get_midcall_result` fn decls (owner calls only),
   prompt rules (confirm-first, relay verbatim, honesty on failure).
4. Cost guard wiring (KVs above) + tests mirroring submit-instruction's
   (route behavior + bot↔route source contract).
5. Deploy = Vercel merge + manual worker deploy; live verify with ONE
   boss-call driving ONE leg B to a test number.
