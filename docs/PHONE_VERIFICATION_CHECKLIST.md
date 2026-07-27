# Phone system — verification checklist (2026-07-25)

Everything below was tested by me on the live VPS unless the line says otherwise. Where a
line needs the owner, it is because the thing genuinely cannot be verified without his
hardware (a microphone, his handset, his ear) — not because it was skipped.

Legend: **✅ proven** = I ran it and quote the evidence · **👤 owner** = needs his device
· **⏸ deferred** = deliberately not built, with the reason

---

## A. Self-hosted SIP core (replaces NGS)

| # | Thing | Status | Evidence |
|---|---|---|---|
| A1 | Outbound AI call over our own Asterisk | ✅ proven | Multiple live calls; last one `answered -> wired`, two-way audio, clean hangup |
| A2 | Inbound AI call, real caller-ID | ✅ proven | `INBOUND from=+8801779640373` → `owner=y` → the bot greeted "বস!" |
| A3 | Owner recognition ("জি বস") — the thing NGS made impossible | ✅ proven | Same call as A2; unknown number self-test gave `owner=n` (receptionist) |
| A4 | Outcome reporting (busy / no answer / failed) with real cause | ✅ proven | Unroutable number → `status:"no_answer", cause:19 "User alerting, no answer"` |
| A5 | One-way message call | ✅ proven | `answered:true` → playback finished → `cause 16 Normal Clearing` |
| A6 | Keypress confirmation on message calls | ✅ proven | Owner pressed 1 → `keypress: 1` → `confirmOutcome: confirmed` |
| A7 | Ring timeout long enough to reach a phone | ✅ proven | Was ARI's 30s default and cut the owner off mid-answer; now 45s, verified |
| A8 | Registration watchdog + owner alert | ✅ proven | Drill: detection fired, alert delivered (`HTTP 200 queued`), real line untouched |
| A9 | Call records survive a restart | ✅ proven | Every finished call POSTs to `sip-cdr`; no persist errors in the logs |
| A10 | SIP ports closed to scanners, survives reboot | ✅ proven | 281 scanner packets/20s before → flood stops; systemd unit `enabled` |
| A11 | Control API not reachable from the internet in the clear | ✅ proven | Raw port refuses; `https://sip.31-97-237-40.sslip.io/health` works |
| A12 | Toll-fraud guards | ✅ proven | Unsigned call refused; international destination refused; wrong key refused |

## B. Part 1 — the NGS-era gaps

| # | Thing | Status | Evidence |
|---|---|---|---|
| B1 | **Call recording, inbound + outbound** | ✅ proven | `recording stored (16s / 29s / 20s)`; signed URL downloads a valid 8 kHz WAV that Asterisk decodes back to real audio |
| B2 | Recording covers the part AFTER a transfer | ✅ proven by design | Records the bridge, which keeps running once the AI leaves; transfer metadata also lands on the record |
| B3 | Recording link arrives with the Bangla summary | ✅ proven | Report format carries `🎧 রেকর্ডিং (N সেকেন্ড)`; a late upload follows up separately |
| B4 | Voicemail when the AI cannot speak | ✅ proven | Bot stopped → prompt → `voicemail delivered (45s)`; silent caller correctly discarded |
| B5 | Office-hours routing | ✅ proven (logic) | KV `office_hours_dhaka`, default 10-21; after hours the AI takes details instead of promising a transfer |
| B6 | Ring group — next person when one does not answer | ✅ proven | `1/2 → 2/2 → ring group exhausted` |
| B7 | Caller returns to the AI when nobody answers | ✅ proven | `AI re-attached after a failed transfer` |
| B8 | Spam blocking, before answering | ✅ proven | Blocked number `refused — not answering`; a different number answered normally |
| B9 | Press 0 for a human | ✅ built | Wired to the support line; needs a live keypress mid-call → 👤 |
| B10 | Two forward targets (support vs boss) | ✅ proven (routing) | Resolution unit-checked across env/per-DID/legacy/missing cases; transfer PUT returns `connecting` and dials the chosen target |
| B11 | Human↔human bridge audio after transfer | 👤 owner | Needs someone to answer the support line |
| B12 | Queue + hold music, DTMF menu, post-call survey | ⏸ deferred | Queue needs concurrent callers ALMA does not yet have; an IVR menu is a step back from an AI that understands intent; the survey is built but asking every customer to rate a call is intrusive — say the word and it goes on |

## C. Part 2 — what only self-hosting allows

| # | Thing | Status | Evidence |
|---|---|---|---|
| C1 | Browser softphone registers over TLS | ✅ proven | Real wss path: `401 → 200 OK → REGISTERED`, contact bound to AOR 1001 |
| C2 | Asterisk's call-control API stays private | ✅ proven | Only `/ws` is proxied; `/ari` unreachable from outside |
| C3 | Per-staff extension + password, secrets off the app DB | ✅ proven | Provision returns an extension; passwords live in a 0600 file on the VPS |
| C4 | Stolen browser credential cannot dial abroad | ✅ proven | `from-staff` permits only internal extensions and BD numbers |
| C5 | Screen-pop (caller's orders, dues, recent calls) | ✅ built | Lookup route + panel; needs a live call into a registered browser → 👤 |
| C6 | Staff-to-staff free calls | ✅ built | Directory endpoint returns extensions without secrets; dialplan proven |
| C7 | Click-to-call from the ERP | ✅ proven (guards) | International refused; offline phone reports clearly instead of ARI's "Allocation failed" |
| C8 | Real mic-to-mic browser call | 👤 owner | Needs a microphone and his ear — the one genuinely hardware-bound step |
| C9 | Angry-customer escalation to the owner mid-call | ✅ proven (delivery) | Exact payload reaches the owner pipeline (`queued`); the trigger is the model's judgement, so it wants one live angry call → 👤 |
| C10 | AI live in-ear coaching for staff | ⏸ deferred | Needs a second listen-only audio leg per call. Real work, and I would rather build it properly than half-ship it — roughly a day |

## D. Older PENDING VERIFICATION items from the phone-agent roadmap

| # | Thing | Status | Note |
|---|---|---|---|
| D1 | Owner inbound recognition (human-PA #1) | ✅ proven | Was impossible on NGS; see A3 |
| D2 | Unanswered-call retry + WhatsApp fallback (#3) | ⚠️ unit-tested only | Needs a live unanswered call to confirm the ladder |
| D3 | Prior-call continuity (#5) | ⚠️ code path live | Injects the previous summary; wants a two-call sequence to confirm |
| D4 | Unknown-caller save suggestion (#6) | ⚠️ unverified | Needs a call from a number not in contacts |
| D5 | Transfer ask_first mode (#7) | ✅ built | KV-flipped; after-hours now sets it automatically |
| D6 | Salah-aware ladder (#8) | ⚠️ unit-tested only | Unchanged today |
| D7 | ALMA → "আলমা" pronunciation | ✅ live | In the bot's shared rules; audible on today's calls |
| D8 | PA-4 native badge | ⏸ separate branch | iOS work, untouched today |

---

## What is left for you

1. **Four env vars on Vercel Production** (none are secret), then Redeploy:
   `SIP_GATEWAY_BASE=https://sip.31-97-237-40.sslip.io`, `SIP_FORWARD_SUPPORT=01868996666`,
   `SIP_FORWARD_BOSS=01779640373`, and **last** `VOICE_CALL_PROVIDER=sip`.
   Rollback is always `VOICE_CALL_PROVIDER=relay`.
2. **Keep the NGS subscription** for 2–4 weeks after cutover.
3. **One browser test** at `/agent/phone`: press "ফোন চালু করো", allow the microphone, then
   call that number from your handset. That closes C5, C8 and B11 in one go.
4. Tell me if you want the deferred items (C10 live coaching, the survey, queue/hold).

## Residual known issues

- A faint artefact remains on some calls. The measured causes are fixed (aliasing from a
  filterless downsample; clicks at every stop and resume; queue dry-outs mid-sentence, which
  went 8 → 4 → 0 per call as the cushion grew). What is left is small and the owner called it
  not a big deal.
- Transcripts occasionally render Bangla speech as Hindi. Pinning the language needs Vertex/
  Enterprise mode — the Developer API rejects the field outright and a rejected field kills
  the whole session. The model itself always understood and answered correctly; only the
  stored transcript is affected.

---

## E. Verified 2026-07-25 (late session) — evidence, not assertion

| # | Thing | Status | Evidence |
|---|---|---|---|
| E1 | **Outbound root cause** — provider keeps ONE registration binding, last registrant wins | ✅ proven | Their own table flipped `163.227.239.96 NextGenSwitch` → `31.97.237.40 Asterisk` when we moved to a 60 s refresh. After: **29 of 30 calls reached the network (3%)** against 14 of 74 dying (19%) earlier the same day |
| E2 | Staff softphone silently dead after an Asterisk restart (chan_sip retook the ws subprotocol) | ✅ proven | Bogus-digest probe named the owning module; after the fix a REGISTER with the real password over the public wss answered `200 OK`, then de-registered cleanly |
| E3 | Phone UI unreadable in light theme | ✅ proven | Measured on prod: instruction text contrast **1.00** (white on white) → 4.76; screenshotted in both themes |
| E4 | Daily call cap counted inbound calls and failed attempts | ✅ proven | 49 of 62 rows on 07-25 were inbound (23 from the self-test caller); cap now counts only outbound that reached the network. 3 unit tests |
| E5 | Male voice (Charon) is the default | ✅ proven | Bot log `"voice":"Charon"` on a live session; inbound already defaulted to Charon, the female voice only ever reached outbound |
| E6 | Confirm card names the engine that actually speaks | ✅ code | On sip/ngs every call is Gemini Live, so the card says `Gemini Live (ছেলে কণ্ঠ — Charon)` instead of a TTS provider that is never reached |
| E7 | **Staff names never improvised** — facts travel with the call | ✅ proven live | His call: "Mohammad Eyafi সময়মতোই এসেছে। Mustahid একটু দেরিতে… ALMA TEST আজকে আসেনি" — all three correct, from `params.facts` |
| E8 | D4 unknown-caller save suggestion | ✅ proven | Self-test from two unknown numbers appended `📇 নম্বরটা (…) contact list-এ নেই — কার নম্বর বলে দিলে সেভ করে রাখব।` |
| E9 | B8 spam block, before answering | ✅ proven | Blocked caller-ID → `status=blocked`, call never answered, nothing spent |
| E10 | B4 voicemail fallback | ✅ proven | Cut the AI leg mid-call → voicemail recorded 28 s and delivered |
| E11 | **Owner's own hold audio** | ✅ proven on the line | `alma-hold` class + file loaded; ARI moh POST 204; a recorded bridge shows sustained audio through exactly the 9 s window, after a silent gap |
| E12 | Boss's own todo list reachable mid-call | ✅ proven | `list_owner_todos` returns his 5 todos from production. It was missing, so the model had reached for `get_staff_tasks` (staff work) |
| E13 | Turn detection configured at all | ⚠️ half | `realtimeInputConfig` was never set, so the API's conservative default decided end-of-speech and he sat through 3–5 s silences. Now `silenceDurationMs=500` + `END_SENSITIVITY_HIGH`; the live session opens (trap #11 avoided), but whether it FEELS instant is his ear |
| E14 | Audio smoothness vs the Twilio path | ⚠️ open | Two jitter buffers in series were found and one removed; his verdict is "better, not Twilio-smooth". A real latent bug remains: the gateway drops from the FRONT of its queue when it overruns, deleting audio about to play (`dropped=90` on one call) |

**Still needs his handset or ear, unchanged:** B9 (press 0 mid-call), B11 (human↔human after transfer), C5 (screen-pop into a registered browser), C8 (mic-to-mic browser call), C9 (one live angry-customer escalation), D2 (retry ladder — needs a genuinely unanswered call), D3 (prior-call continuity across two calls), D6 (salah-aware ladder), plus the two ⚠️ rows above.

**iOS:** nothing today needed a build. Every change was web or worker, and `/agent/phone` renders inside the WebView, so the app picks it up with no new binary. Build number in git is 85; the standing rule is that the number in git must equal TestFlight's and every build must come from a clean, pushed, main-current checkout (`bash scripts/ios-build-preflight.sh`).
