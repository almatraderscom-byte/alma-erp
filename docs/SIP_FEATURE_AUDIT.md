# Phone stack — feature audit (what we have, what NGS had, what only self-hosting can do)

Written 2026-07-25 after Phases 1–3 of the self-hosted SIP build, at the owner's request:
"deep audit kore NGS ba aro best platform research kore aro ki ki feature amra kori ni".

Benchmarks used: NextGenSwitch/EasyPBX's own published feature list (the platform we are
replacing), and the standard Asterisk/FreePBX + WebRTC feature set that self-hosting unlocks.

---

## 1. What we already have (built + live-proven)

| Capability | State |
|---|---|
| Outbound two-way AI calls (Bangla, barge-in) | live |
| Inbound AI answering with REAL caller-ID | live (NGS could not do this) |
| Owner recognition ("বস") vs customer receptionist | live |
| Live transfer to a human, two targets (support / boss) | live |
| One-way message/alert calls | live |
| Keypress confirmation on message calls (1/2) | live |
| Mid-call ERP tools (sales, orders, stock, attendance…) | live |
| Voice → head-agent task submission | live |
| Post-call transcript + Bangla summary + cost estimate | live |
| Outcome reporting (busy / no-answer / failed) with hangup cause | live |
| Multi-DID persona map (boss line vs support line) | built, needs a 2nd DID |
| Concurrency cap, per-call token auth, SIP port firewall | live |

## 2. Reliability gaps — RISKS, not features (recommend doing these first)

These are things that can silently break the phone line. NGS ran their own monitoring; now
that we own the stack, we own the monitoring too.

1. **Registration-drop alarm.** Inbound depends entirely on our SIP registration holding. If
   it drops (trunk restart, network blip, credential change) **every incoming call dies and
   nothing tells us**. Need a watchdog: check `pjsip show registrations` every minute, alert
   the owner on Telegram/ntfy after 2 consecutive failures, and auto re-register.
2. **CDR only lives in memory.** The gateway's call record ring is lost on restart, so call
   history/outcomes/cost vanish. Should be written to Postgres (we already have the
   `agent_voice_calls` table) for every call, including one-way and inbound.
3. **After a transfer we go blind.** Once the AI hands a caller to a human, that conversation
   is unrecorded and unreported — the owner never learns what was agreed. NGS could at least
   record it. Fix = record the bridged leg (below) + a short post-transfer note.
4. **Firewall is not reboot-persistent** and there is no fail2ban. After a VPS reboot the SIP
   ports are open again (fails open — no outage, but no protection).
5. **No trunk-balance / second-trunk failover.** If the trunk account runs dry or the provider
   has an outage, all calls stop. A cheap second SIP trunk + auto-failover removes a single
   point of failure.

## 3. Features NGS had that we have NOT built

| # | Feature | Why it matters for ALMA | Effort |
|---|---|---|---|
| 1 | **Voicemail** + AI summary to Telegram | After hours / nobody answers, the caller can leave a message instead of hanging up | S |
| 2 | **Call recording** (audio) + searchable transcripts | Dispute resolution, staff quality, and it closes the after-transfer blind spot | M |
| 3 | **Call queue + hold music** | When the support line is busy, callers wait instead of failing back to the AI | M |
| 4 | **Ring group / hunt** (try support → staff 2 → boss) | One person not answering shouldn't lose the customer | S |
| 5 | **Time-based routing** (office hours vs after hours) | After hours: AI takes a message; during hours: reach a human | S |
| 6 | **DTMF IVR fallback** ("1 = order status, 2 = support") | Noisy lines and elderly callers where speech recognition struggles | S |
| 7 | **Blacklist / spam block** | Repeat nuisance callers stop reaching the line at all | S |
| 8 | **Call monitoring / whisper / barge** | Owner silently listens to a staff call, or coaches without the customer hearing | M |
| 9 | **Post-call survey** (rate 1–5 by keypress) | Real CSAT data; the keypress plumbing already exists | S |
| 10 | **Callback request** instead of waiting | Customer keeps their place without holding | M |
| 11 | **Answering-machine detection** on outbound | Don't waste a message (and money) on a voicemail beep | M |
| 12 | **Real-time dashboard** of live/recent calls | See what the phone line is doing right now | M |

## 4. Things only self-hosting can do (NGS could never sell us these)

| # | Feature | Why it is a big deal | Effort |
|---|---|---|---|
| 13 | **WebRTC softphone inside the ERP** | Staff answer customer calls **in the browser** — no SIM, no phone bill, no extra device. Calls land where the order data already is | L |
| 14 | **Screen-pop / auto customer lookup** | The moment a call comes in, whoever answers sees that customer's orders, dues and history | M |
| 15 | **Internal extensions** (staff ↔ staff, free) | In-house calling with no per-minute cost; overlaps the current Agora intercom spend | M |
| 16 | **Click-to-call from the ERP** | Click a customer row → your phone rings → it connects you | S |
| 17 | **AI whisper-coach on human calls** | AI listens to a staff↔customer call and texts the staff member suggestions live | L |
| 18 | **Auto-escalation on anger/urgency** | AI detects a frustrated customer and pulls in the owner mid-call | M |
| 19 | **Unlimited DIDs / lines, no per-seat fee** | Add a support line, a delivery line, a campaign line — cost is just the DID | S |
| 20 | **Full audio-chain control** | This is what lets us actually fix the crackle properly (and use wideband codecs internally) | — |

## 5. Agent-specific upgrades (our AI, not standard PBX)

| # | Feature | Why | Effort |
|---|---|---|---|
| 21 | **Caller history context** ("this number called 3× this week, last about order #123") | The AI stops treating a repeat customer like a stranger | S |
| 22 | **Scheduled + rate-limited outbound batches** | Order confirmations / delivery reminders without spamming or blowing cost | M |
| 23 | **SMS follow-up after a call** (BD gateway) | "Here's the link we discussed" — closes the loop in writing | M |
| 24 | **Voicemail → agent** | AI listens to voicemail, summarises, and drafts the reply | S (after #1) |

---

## Recommended order (my opinion, for the owner to confirm)

**Round A — stop the bleeding (small, high value):** #1 registration alarm, #2 CDR to Postgres,
#4 firewall persistence + fail2ban, #21 caller history context.
**Round B — customer experience:** voicemail (#1), ring group (#4), time-based routing (#5),
call recording (#2), post-call survey (#9).
**Round C — the big self-hosted win:** WebRTC softphone in the ERP (#13) + screen-pop (#14) +
internal extensions (#15).
**Round D — nice to have:** IVR fallback, queue + hold, whisper/barge, callback, AMD, dashboard.

Effort key: S = a few hours, M = a day-ish, L = multi-day.

Sources: NextGenSwitch published feature list (nextgenswitch.com/features, /docs/overview),
Asterisk WebRTC / Browser Phone ecosystem (browser-phone.org, innovateasterisk.com).
