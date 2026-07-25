# ALMA PBX Console — roadmap for a phone section inside the ERP

**Status: plan only. Nothing here is built.** Written 2026-07-25 at the owner's request, to be
implemented in later sessions.

---

## 1. Why this exists

NGS/EasyPBX was a paid middleman, and we replaced it — the trunk was always the owner's own
account. We gained the things it could never do: the real caller-ID, our own recordings, our
own AI, no per-seat fee.

We also lost the one thing it was good at: **a screen**. NGS gave him trunks, extensions,
routes, live channels, call logs, recordings, reports and cost in a browser. Today all of that
lives in `pjsip.conf`, in env vars behind SSH, and in KV rows with no UI (see
`PHONE_FEATURES_IN_MAIN.md`). The system is more capable and less operable, and every change
routes through an engineer.

**Goal: an ALMA-native phone section where the owner runs his own PBX — web only, no app work.**

---

## 2. What NGS actually had

Audited from the live panel, 2026-07-25. Grouped by what we should do about it.

### 2a. Build — this is the console

| NGS section | What it gave him | Our state today |
|---|---|---|
| Trunks | add/edit/delete trunk, live registration status, call limit | `pjsip.conf` over SSH |
| Extensions | create staff SIP users, secrets, call limit, allowed IPs, DND, forwarding | API only, no screen |
| Inbound Routes | per-DID pattern → destination | dialplan + `didConfig()` in code |
| Outbound Routes | dial patterns, prefix add/strip, per-trunk priority | dialplan |
| Ring Group | members, strategy, rounds, timeout | env + code |
| Call Logs | every call: direction, status, duration, cause | DB, Telegram only |
| Voice Record Logs | recordings, searchable, playable | Supabase + Telegram only |
| Active Channels | who is on a call, right now | `asterisk -rx` over SSH |
| Main Dashboard | active/waiting calls, answered, SLA, totals | nothing |
| Trunk / Extension Summary | per-trunk and per-extension volume | nothing |
| Time Groups / Conditions | office hours, holidays | KV `office_hours_dhaka`, no screen |
| Announcements / Voice Files | hold audio, prompts | files on the VPS |
| DNC List | do-not-call | KV `blocked_callers`, no screen |
| Make a Call (web dialer) | click to dial from the panel | `/agent/phone` ✅ (the one thing we have) |

### 2b. Don't build — the AI already replaces it

| NGS section | Why not |
|---|---|
| IVR menus | "press 1 for sales" is a step BACKWARDS from an agent that understands intent. Keep press-0-for-human as the escape hatch and nothing else. |
| Call Queue / Parking / Hotdesk | Built for a floor of agents. ALMA has two staff and an AI that answers instantly. Revisit only when there are real concurrent callers. |
| Autonomous Agents / AI Assistant / AI Providers | We ARE the AI layer; ours is far ahead of theirs. |
| Surveys | Built once, deliberately off — asking every customer to rate a call is intrusive. |

### 2c. Don't build — the ERP already has it, better

CRM, Contacts, Companies, Leads, Deals/Pipeline, Tasks, Support Tickets, Campaigns, Broadcasts,
Integrations, Users, Invoices. Wiring the phone INTO these (screen-pop, click-to-call, call
history on a customer) is the real win, and most of it already exists.

---

## 3. Architecture — decide once, before any screen

Four rules, each of which prevents a specific failure this system has already had.

**3.1 One writer for Asterisk config.** Screens must never write `pjsip.conf` directly. They
call a **gateway control-plane endpoint** which validates, backs up, writes, reloads the right
module, verifies, and rolls back on failure. Reason: a plain `reload` silently ignored a new
MOH class today, and a `noload` line in the wrong section left the softphone dead for hours.
Config changes need a verifying writer, not a text editor.

**3.2 Secrets never leave the VPS.** Trunk and extension passwords live in
`/opt/alma-erp/worker/.env` and `0600` files on the box. The console shows *status*, never a
secret; "reveal password" is not a feature we copy from NGS. Setting a new password posts it to
the VPS and forgets it.

**3.3 Settings live in KV, not env, wherever a human might change them.** Anything the owner
would plausibly change — office hours, forward numbers, blocklist, ring rounds, voice, caps —
moves from env to `agent_kv_settings` so a screen can write it and the change takes effect
without a redeploy. Env stays for infrastructure (hosts, ports, tokens).

**3.4 Every change is audited and reversible.** Who changed what, when, and the previous value.
A phone system that silently changed under you is exactly how a whole day disappears.

---

## 4. Phases

Each phase is independently shippable and useful on its own. Ordered by value per unit of work.

### Phase 1 — See the line (read-only)  ·  the biggest win, the least risk

A `/agent/phone-console` page. No writes at all.

- **Line health**: registered or not, seconds to next refresh, **and the provider's own view**
  (their table is the only truth — our `200 OK` means nothing, that lesson cost two sessions)
- **Live**: active calls, who, how long, which leg
- **Today**: calls in/out, answered, missed, voicemail, average length
- **Call log**: every call with direction, number, name if known, status, duration, hangup
  cause, **inline recording player**, transcript and Bangla summary
- **Quality per call**: `underruns`, cushion, dropped frames — already logged by the gateway,
  currently visible only by SSH
- Filters: date, direction, status, number

Data: `agent_voice_calls` + gateway `/health` + `pjsip show registrations` via the control API.
Nothing new to store.

### Phase 2 — Change settings without SSH

Same page, a Settings tab. Each row moves from env/KV to a KV-backed screen:

- forward targets (support / boss), and which one the AI may use for what
- office hours + holidays; after-hours behaviour
- transfer mode (direct vs ask-first)
- blocklist / DNC, with "block this caller" straight from the call log
- ring group members, rounds, per-member timeout
- concurrency cap, daily call cap
- voice (male/female, provider), turn-detection speed
- hold audio: upload a file, hear it, make it live (today: SSH + `ffmpeg` + a module reload)

### Phase 3 — Extensions

- list staff extensions, registration state, last seen, current call
- create / disable / rotate password (writes to the VPS, secret never returned)
- a provisioning link so a staff member sets up their browser phone themselves
- per-extension: allowed to dial out, allowed destinations, DND, forward-to-mobile
- per-extension call history + recordings

### Phase 4 — Routing

- **Inbound**: DID → what answers it (AI persona, staff, voicemail, hours-dependent)
- **Outbound**: which trunk, dial patterns, prefix rules, per-destination allow/deny
- **Time conditions**: office hours, Friday, holidays, Ramadan hours
- Preview before save: "a call from 01712345678 at 21:30 would reach …" — routing bugs are
  invisible until a customer hits them

### Phase 5 — Trunks

- add / edit / disable a trunk: host, port, transport, username, password, call limit
- live registration status **as the provider sees it**, with the history of when it flapped
- a second trunk for failover, with automatic failover rules
- **hard rule, learned the expensive way: never let two PBXs register one account.** The screen
  must refuse to enable a trunk whose account is already bound elsewhere, and say why.

### Phase 6 — Cost

Nothing about money is in the ERP today; it lives only on the provider's website.

- per-call cost, per-day and per-month spend, by direction and destination
- provider balance and a low-balance alert before the line dies mid-day
- cost per AI minute (Gemini) beside cost per telephony minute — the true cost of a call
- Source: our CDR for volume + a rate table; their panel for balance. If they expose an API,
  ingest it; if not, one number the owner updates, plus our own computed spend.

### Phase 7 — Monitoring and quality

- live "who is on a call" with listen-in (supervisor spy) for training
- call-quality trend: underruns and dropped frames per day, so audio regressions are caught by
  a graph rather than by the owner's ear
- alerts already exist (registration, softphone) — surface them here with their history

### Phase 8 — Optional, only if the business asks

Outbound campaigns (dial a list), broadcasts, post-call survey, queue + hold for genuinely
concurrent callers. All were built or half-built in NGS; none matter at ALMA's current volume.

---

## 5. Where it should live in the ERP

- `/agent/phone` stays exactly as it is — the staff softphone, used during a call
- `/agent/phone-console` (owner-only) is the new section: Overview · Calls · Settings ·
  Extensions · Routing · Trunks · Cost
- Reuse the ALMA design system (coral `#E07A5F`, aurora, Liquid Glass) and the existing
  role-based Office layout. Owner-only by role, not by obscurity.

---

## 6. Risks worth naming before starting

- **This is a live business line.** Every write path needs a dry-run, a backup and a rollback.
  Nothing in this console may be able to break inbound calls; if a change cannot be verified
  automatically, it does not get a button.
- **Asterisk reloads are not uniformly honest** — some config takes a full module unload/load
  (proven with music-on-hold today). The control plane must verify the effect, not trust the
  command's exit code.
- **Don't rebuild NGS.** The parts of it that mattered are §2a; the rest is a call-centre
  product for a business we are not. Building all of it would waste months and add surface to
  maintain.
- **Two PBXs on one SIP account is the single most expensive bug this system has had.** It cost
  roughly half of all outbound calls for days and looked like a provider fault. Phase 5 must
  make that state unreachable from the UI.
