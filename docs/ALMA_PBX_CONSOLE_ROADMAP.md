# ALMA PBX Console — roadmap for a phone section inside the ERP

**Status: Phase 1 is BUILT and LIVE** (merged 2026-07-26, PR #585, `f7bbf44d`) at
`/agent/phone-console`. Phases 2–8 are still plan only. Written 2026-07-25; Phase 1 status and
the lessons it produced were added 2026-07-26.

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

**Updated 2026-07-26** — after Phase 1 the "our state today" column reads differently: Call
Logs, Voice Record Logs, Active Channels, the Main Dashboard and the trunk/registration view
all now have a screen. Extensions, routes, ring group, time conditions, announcements and DNC
are still API/env/conf only, and those are exactly what Phases 2–5 cover.

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

### Phase 1 — See the line (read-only)  ·  ✅ DONE 2026-07-26

Not a page — a **section**. The first cut was one long scrolling page of cards and the owner
rejected it: he runs the phone system the way he ran the old EasyPBX control console. Later
phases must keep this shape.

    /agent/phone-console              ড্যাশবোর্ড    KPIs, in/out split, daily trend
                        /live         লাইভ চ্যানেল   who is on the line, 3 s refresh
                        /calls        কল লগ         filters, table, paging, CSV export
                        /recordings   রেকর্ডিং       laid out for listening
                        /quality      অডিও কোয়ালিটি  our counters AND the network's
                        /line         লাইন ও ট্রাঙ্ক  registration, binding, caps

Owner-only is enforced in the section layout, not per page, so a new sub-page cannot ship open
by omission. Later phases appear in the navigation already, visibly disabled and tagged with
their step number.

**What it delivers** (all of the original list except the provider's own view):

- **Line health**: registered or not, seconds left on the binding, concurrency, hourly cap,
  softphone stack health — every screen labels it as OUR claim and links to the provider's
  panel. **The provider's own table is NOT in — it needs their login, so it moves to Phase 2.**
- **Live**: active calls, who, how long, which leg
- **Today**: calls in/out, answered, missed, voicemail, average length
- **Call log**: every call with direction, number, name if known, status, duration, hangup
  cause, **inline recording player**, transcript and Bangla summary
- **Quality per call**: `underruns`, cushion, dropped frames — already logged by the gateway,
  currently visible only by SSH
- Filters: date, direction, status, number

Data: `agent_voice_calls` + a new authenticated `GET /api/v1/active` on the gateway +
`pjsip show registrations`. Two things turned out to be needed after all:

- **Additive columns.** The gateway had always POSTed direction, the caller's number, the DID,
  the ISDN hangup cause and the transfer outcome to `sip-cdr`; the route had nowhere to put
  them and dropped them. Migrations `20260921000000` and `20260922000000` add those plus the
  audio and RTP counters. They fill FORWARD only — older rows stay blank.
- **Per-call network numbers**, which were not in the original plan and belong here rather
  than in Phase 7. See "What Phase 1 changed" below.

Also built beyond the plan: a CSV export (with a BOM, so Bangla opens as Bangla in Excel) and
the audio-quality page.

---

### What Phase 1 changed for everything after it

Written down because each of these cost real time to learn.

**1. The audio tuning is now LOCKED — CLAUDE.md hard rule #1.** The owner listened to a live
call on 2026-07-26 and called the voice perfect. Every tuning value is a code default with
deliberately NO env override, so it lives in git and cannot be changed quietly over SSH. Any
later phase that touches voice must state that it does not change those values and prove it on
a real call: `underruns ≤ 1 · cushion ≤ 16f · dropped = 0`.

**2. A recording can never show what the network did.** A call's audio is recorded inside
Asterisk, before it goes on the wire — which is exactly why a recording sounds clean while the
call did not. The gateway now samples `pjsip show channelstats` every 10 s per live call and
puts packet loss / jitter / RTT on the CDR, and the quality page shows our own counters and the
network's side by side. This makes most of Phase 7 unnecessary as a separate step.

**3. Do not ask a model to listen to a recording to find a root cause.** It can only say "it
sounds choppy", which is already known. Measure at each hop instead, and make the hops
separable.

**4. `Local/<did>@from-alma` is NOT a PSTN loopback.** `from-alma` is the INBOUND context, so
the call never leaves the box — 70 seconds of it produced zero RTP packets on eth0. A real
loopback goes out through the gateway's `POST /api/v1/call` to our own DID `09649777738`.

**5. A loopback occupies BOTH channels of a 2-channel trunk**, so loss and stall numbers taken
from one are not representative of an ordinary single-channel call. Say so rather than blaming
the provider.

**6. The codec suspicion was tested and REJECTED before anything was implemented.** We offer
PCMU + PCMA at ptime 20; the provider answers PCMU only. They choose it, and there is no
transcoding to blame.

**7. Deploy order decides whether the console has data.** The gateway posts CDRs to `APP_URL`,
which is PRODUCTION. New CDR columns therefore stay empty on a preview no matter how correct
the code is, until the branch is merged. Worker deploys were done as `origin/main` plus only
the worker files, on a `vps-gateway-only` branch, so the box never takes unrelated commits.

**8. The old panel had nothing left to give.** Its trunk was deleted during the cutover and a
hosted panel exposes no media settings to a client, so the answer to an audio question is not
in there — it is in our own packets and counters.

### Phase 2 — Change settings without SSH  ·  ✅ BUILT 2026-07-26

Not one page — a **settings GROUP** in the section nav, one page per job, because eight
unrelated things on a single scroll is the shape the owner rejected in Phase 1:

    /agent/phone-console/settings             ফরওয়ার্ড ও ট্রান্সফার  numbers, ring group, mode, rounds
                                 /hours       অফিস সময়              window + holidays
                                 /blocklist   ব্লকলিস্ট               refuse before answering
                                 /limits      সীমা ও ক্যাপ           concurrency, caps, voicemail
                                 /hold        হোল্ড অডিও             upload → live, verified
                                 /provider    প্রোভাইডার              amarip's own registration table
                                 /history     পরিবর্তনের ইতিহাস       who/what/when + revert

**Where the settings actually lived, which is the thing that shaped the work.** They were not
all in one place, and only half were reachable from Vercel:

- **App-scoped** (read by `sip-inbound` while a call is being set up, so a change applies to
  the very next call): forward targets, office hours, holidays, transfer mode, blocklist,
  daily call cap. The inbound route already sent a per-call `params` object to the gateway,
  so these needed no VPS work at all.
- **Gateway-scoped** (read on the VPS): ring rounds, per-member ring timeout, outbound ring
  timeout, concurrency cap, voicemail length, hold-music class, the pre-answer blocklist.
  These were env vars behind SSH, so "settings without SSH" would have been half true. The
  gateway now **pulls** `GET /api/assistant/internal/phone-config` once a minute and falls
  back to its env on any failure. A pull, not a push: no inbound port, it re-syncs itself
  after a restart, and a failure leaves the last known-good values rather than half a config.
- **Locked** — the roadmap's original list had "voice (male/female)" and "turn-detection
  speed" in this phase. Both are frozen by CLAUDE.md hard rule #1. They ship **read-only**,
  on the limits page, with the reason. The roadmap does not outrank the lock.

Everything falls back to the env var that used to control it, so an empty settings table
behaves exactly like the system did before — the migration is the absence of a change.

**Hold audio** is the one config WRITE that reaches the VPS, and it is the first citizen of
§3.1's verifying control plane: upload → `ffmpeg` to 8 kHz mono (`.wav` + `.sln` off one
basename) → declare the class if absent (config backed up first) → `module unload` + `module
load` → **verify with `moh show classes`** → roll both halves back on failure. It refuses
while any call is up, because unloading MOH cuts the music out from under whoever is on hold.

**The provider's registration table** (carried over from Phase 1) is on its own page. The
owner types the amarip.net password himself; it is stored AES-256-GCM encrypted in its own
table — deliberately not in `agent_kv_settings`, whose whole contents the agent's own
`get_settings` tool can read — and is never returned by any route. We have no documentation
for their panel, so both URLs are editable on the page and an unparseable response shows the
first 400 characters of what actually came back instead of an empty table.

**Audit** is `agent_audit_logs`, one row per change with the previous value and who made it.
Only the newest change per key can be reverted: putting back a value something newer already
replaced would silently undo the newer change too.

Migration `20260923000000_phone_provider_credential` (additive: one new table).

### What Phase 2 changed for everything after it

**1. There are two config planes, not one, and a screen must say which it is on.** An
app-scoped change applies to the next call; a gateway-scoped one waits up to a minute. The
settings screen labels gateway rows and shows when the gateway last pulled, so a change can
be seen to have LANDED rather than merely been saved. Phases 3–5 write to the VPS far more
than this one does — build on the pull, not on a new push path.

**2. The gateway now trusts the ERP for values, so the gateway re-validates them.** Every
pulled number is range-checked again on the VPS. A bad number reaching the playout side is
not a screen bug, it is a dead line, and that file is the last thing standing between the two.

**3. Nothing audio-shaped goes through the pull, and a test enforces it.** The gateway config
payload is asserted as an exact key set, so a later phase cannot quietly add a jitter value or
the voice name to something reachable over the network.

**4. `/api/assistant/internal/` was the right home for the pull endpoint.** Middleware exempts
that whole prefix from the session check; a new voice route elsewhere 401s until someone
remembers to list it by exact pathname (trap #8). Later phases should put machine-to-machine
endpoints there for the same reason.

**5. Deploy order again, and it is worse for writes than for reads.** The gateway pulls from
`APP_URL`, which is PRODUCTION. Gateway-scoped settings therefore cannot be proven on a
preview at all — only the app-scoped half can. The honest sequence is: merge, deploy the
worker, then verify on a real call.

### Phase 3 — Extensions  ·  ✅ BUILT 2026-07-26

`/agent/phone-console/extensions`. Before this, extensions existed only as an API: a staff
member got one by opening the phone page, and no screen anywhere could answer "who has a
phone", "is Karim's connected right now", or "stop this person dialling out".

- **List + live state**: registration read from `pjsip show contacts` (WebRTC AORs run with
  qualify off, so a contact exists exactly while a browser holds the websocket — that is the
  honest source), and who is on a call right now from ARI's channel list.
- **Per-extension policy**: dial-out level (all BD / mobiles only / internal only), DND, and
  forward-to-mobile when the browser does not answer. Enforced in **generated dialplan
  contexts**, not by a runtime check someone can forget to write.
- **Disable** leaves the endpoint out of the generated pjsip config entirely, so a disabled
  extension cannot register at all — a much stronger statement than refusing its calls.
- **Rotate / remove**, and the secret never comes back. Not on create, not on rotate, not
  ever: their browser fetches it when they open the phone page, which is the only place it
  is needed. "Reveal password" is a feature of the old panel we deliberately did not copy.
- **Who has no phone yet** is listed too, with the link to send them — the absence is the
  thing a screen of existing extensions can never show.
- **Per-extension history** comes from Asterisk's own CDR CSV on the VPS, because a staff
  member's calls never pass through the gateway: their browser registers straight to Asterisk
  and the dialplan dials out, so `agent_voice_calls` has no row for any of them. When that
  log is unavailable the screen says so rather than showing an empty list, which would read
  as "this person has made no calls".

**Not delivered, and why:** recordings per extension. We record the AI's bridge, not
staff-to-customer calls, so there is nothing to play. The screen says that instead of showing
a dead player.

**One-time VPS step** (with the worker deploy): `extensions.conf` gets
`#include "extensions-alma-staff.conf"` and its hand-written `[from-staff]` block is deleted.
Full instructions and a rollback copy: `worker/deploy/asterisk/alma-staff-dialplan.conf`.

### Phase 4 — Routing  ·  ✅ BUILT 2026-07-26

`/agent/phone-console/routing` — ইনবাউন্ড লাইন · আউটবাউন্ড নিয়ম · রাউটিং পরীক্ষা.

- **Inbound** needs no VPS change at all, which is the safest possible shape for it:
  `from-alma` already forwards the dialled DID to the gateway, which passes it to the inbound
  route, so per-DID routing is decided entirely in the app. The `SIP_DID_MAP` env JSON moves
  to KV and is edited as a table (label, boss/support line, per-line forward overrides, and
  an allow-transfer switch for a line that should only ever reach the AI). The env is still
  the fallback, in the same shape.
- **Outbound**: destination policy (all BD / mobiles only / internal only) plus strip and
  prefix rules, pulled by the gateway. These sit IN FRONT of the env-pinned `DEST_ALLOW`
  backstop and never replace it — if a pulled policy were ever wrong the worst it can do is
  refuse calls, never permit an international one. Toll fraud is the expensive direction, so
  the guard that cannot be changed remotely stays the ceiling.
- **Time conditions**: holidays and the daily window (step 2), plus weekly off-days and
  date-ranged special hours (`2027-02-18..2027-03-19=10-16`) which covers Ramadan without a
  Ramadan-shaped feature. Ranked holiday → weekly off-day → special hours → ordinary hours,
  and the winning rule travels with the verdict — so the AI can now say *why* it is closed
  ("আজ ছুটির দিন" reads very differently to a customer from "অফিস সময়ের বাইরে").
- **Preview**: "a call from 01712345678 at 21:30 would reach …", plus what an outbound number
  would actually be dialled as. **It calls the same `decideInbound()` and
  `applyOutboundRules()` the live call path calls** — nothing on that page re-derives a rule.
  This is why the routing logic moved out of the inbound handler in the first place: a
  preview with its own copy of the rules is the most confident liar you can put in front of
  someone, about the one thing whose bugs stay invisible until a customer hits them.

### What Phases 3 and 4 changed for everything after them

**1. The gateway is now a config WRITER, with a verify step, twice over.** Hold audio (step
2) and the staff dialplan (step 3) both follow the same shape: back up → write → reload →
prove with a `show` command → restore on failure. Phase 5 writes trunks; use this shape, and
keep the proof a `show`, never an exit code.

**2. A generated file must have exactly one definition.** The staff dialplan's one-time
migration deletes the hand-written `[from-staff]` before adding the `#include`. Leaving both
means the last definition wins, which one that is depends on include order, and the console
would appear to change nothing. Any future generated context inherits this hazard.

**3. Config rendering must not be able to break provisioning.** `renderWebrtcConfig()` is
called when a staff member opens the phone page for the first time, so a dialplan-render
failure there is logged, not thrown — otherwise a CLI blip means nobody can get a phone. The
console's own policy endpoints pass `strict: true`, because there the dialplan IS the
request and a silent failure would show a saved setting that never took effect.

**4. The preview pattern is the deliverable, not the screen.** Moving the routing rules into
one function that both the live path and the preview call is what makes the preview true.
Phase 5's "would this trunk change break inbound" belongs in the same shape.

**5. Permission checks live on the box, not in the app.** The gateway re-runs the outbound
rules itself rather than trusting the ERP's answer. A gateway that trusted the network for a
toll-fraud check would be one leaked token away from an expensive night.

**6. Seven defects survived typecheck, build and 44 tests, and died in the browser.** They are
all the same shape — code that was *reasoned* about instead of *run*. Per-extension history
showed our own DID as the person every staff member had called, because the dialplan rewrites
the caller-ID before dialling out so `src` never equals the extension. Live state read
`undefined` as `false`, so the screen would have insisted every phone was disconnected during
the whole window between merge and worker deploy. A `h-4.5` class Tailwind does not generate
made the DND toggle invisible in the light theme. **Verify in the browser and against the real
box — including the intermediate states a deploy passes through, which is where three of the
seven lived.**

**7. `deploy-worker.yml` cannot reach the VPS** — the runner's egress IP is firewalled, so the
workflow fails on its own probe. Deploy by hand from an allowed Mac; the commands are in
`PHONE_SYSTEM_HANDOFF.md` §8.

**8. Phases 2–4 are verified live** (2026-07-26): config pull landed, the dialplan migration is
done with a rollback copy on the box, and a PSTN loopback to our own DID measured
`underruns=0 · cushion=12f · dropped=0` on both legs — the locked audio is untouched.

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
