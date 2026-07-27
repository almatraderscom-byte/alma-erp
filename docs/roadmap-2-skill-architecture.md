# Roadmap 2 — the skill architecture

**Own session. Own branch** (do NOT continue on
`claude/roadmap-plan-8e52ff` — owner's instruction 2026-07-26; suggest
`claude/skills-architecture`).
Sister roadmap: `docs/roadmap-1-agent-finishes-the-job.md`.

Design of record with research, sources and the full phase plan:
`docs/skill-first-architecture-plan.md`. This file is the STATUS — what is done,
what is not, and where to pick up.

---

## The decision, settled — do not re-open it

The owner asked for skills with their own system prompt, unaffected by other
rules. That is **subagent** semantics, not skill semantics. The answer:

> **The skill FILE is the knowledge. The skill RUNNER is the isolation.**

And the enforcement is never the wording:

> **A prompt rule is a request. An absent tool is a guarantee.**

Everything that has held in this codebase — listen mode, chat modes, "don't ask
me", the read-only audit skill — held because a tool was withheld.

## Authority ladder (fixed)

```
1. Safety, permissions, sandbox           ← no skill touches these
2. Money, approvals, publish gates        ← enforced in CODE, not in text
3. ALMA invariants (alma-base)
4. Boss's instruction this turn
5. The selected skill's workflow          ← this is what a skill controls
```

A skill displaces the general behavioural prompt. It never displaces the gates.

---

## Done (SK-0 … SK-5), all measured

| Phase | Result |
|---|---|
| **SK-0** measure | Router **61%** on his real messages. And the finding that explains everything: the loader only serves `status: active` skills and **15 of the 16 were `draft`** — flipping the engine on would have exposed exactly one skill. They were never offered, so they never did anything. |
| **SK-1** eval harness | 5 dimensions (routing / procedure / safety / honesty / completion). Safety and honesty are pass-fail, never a curve. `compareToBaseline()` blocks a skill if ANY scenario regressed, even when the average improved — the research found 13 of 87 tasks got worse with skills. Validated by replaying this week's real failures. |
| **SK-2** format v2 + linter | `alma-base` holds the invariants once (`implicit: false`, inherited not selected). Linter verdict on our own skills: **79 findings, 12 errors** — 16 of 16 descriptions say WHAT but not WHEN, which is the cleanest explanation of the 61%. Two thresholds calibrated on real data, not guessed. |
| **SK-3** router | **61% → 78%, false triggers 1 → 0.** Filter → deterministic rules → model only for what is left. Fix-vs-audit never reaches a model. Pin per conversation (a 5k-token skill re-picked每 turn destroys the prompt cache). Trace stored: layer, reason, runner-up. |
| **SK-4** enforcement | Tool allowlist from the skill; dependencies checked before step 0; `done:` gate against real tool records. `find_tool`/`ask_user`/`save_memory` always survive so a skill can never be trapped. |
| **SK-5** the three SEO skills | `seo-auditing-own-site` (read-only, holds no write tool), `seo-fixing-own-site` (writes via approval card, has its own `SYSTEM.md`), `seo-fixing-client-site` (no DB, no login). Zero lint findings. Originals stay `draft` — promoted one at a time with evals, never in a batch. |

### Did the skill actually help? — live, measured

| | no skill | with `seo-fixing-own-site` |
|---|---|---|
| turn 1 | 1m 5s · 9 steps · $0.2743 | 41s · 5 steps · $0.0098 |
| batch staged | **1 product** | **10**, labelled "ব্যাচ ১" |
| needed a nudge not to stop | yes | no |
| wasted a call on placeholder URLs | yes | no |

The decisive moment was not the numbers. Asked to fix alt text, the agent
verified a live page first and wrote: *"the **skill warned me about this exact
situation**… zero of them are alt text problems"* — reaching in under a minute
the conclusion that had cost me a morning of hand-checking, because that
morning's finding was in `traps.md`. Then it redirected to the real work.

**Verdict: helped.** Honest caveat: part of the cost gap is DeepSeek vs Sonnet,
so the single-variable claim is the behaviour, not the 28× price.

---

## SK-7 — `isolation: subagent` (2026-07-27, branch `claude/skills-architecture`)

Built. The measured gap first: **`SYSTEM.md` had sat on disk since SK-5 and no
code ever opened it**, and `extends: alma-base` was never resolved either. The
file meant to replace the general prompt was never read, which is why isolation
"existed" only as a manifest field.

A pinned skill declaring `isolation: subagent` now makes the STABLE prompt
`compileStableCore()` + alma-base + its `SYSTEM.md` + its `SKILL.md`. The ~25
business-domain modules are not assembled at all. Only the stable prompt is
swapped — per-turn state (memory, time, project instructions, dependency
preflight) is not behavioural prose and an isolated job needs it too.

| | inline (today) | isolated |
|---|---|---|
| stable prompt | 99,245 chars | **19,401** (−80%) |
| unrelated modules present | 22 | **0** |

Enforcement is measured, not asserted: `findPromptLeaks()` searches the prompt
that was actually built for the text of any non-kernel module. A companion test
asserts a NORMAL turn still shows 22, so the check cannot pass vacuously. The
`skill_pinned` SSE event carries `isolated`, so the claim is checkable from
outside the server.

**Deliberately not `runSubAgent`,** which the plan suggested. That runner caps at
4 tool iterations and 2048 output tokens, does not stream, and returns a summary
string — the SEO batch needs 5–7 rounds and the owner asked to watch the work.
Isolation is the two things that carry the guarantee — own system prompt, own
tool list — delivered inside the streaming turn.

Gate: `AGENT_SKILL_ISOLATION` (off in prod, auto-on preview) **and** a
conversation pin. Without a pin the selection can move mid-chat, and swapping
the system prompt per turn would rewrite the cached prefix every message.

## SK-6 — global hacks into skills (2026-07-27, same branch)

Two slices shipped. The rule applied throughout: **global code keeps what is
true of every job; a skill keeps what is true of one job.**

1. `buildOwnerRequirementNote` stopped emitting the client-SEO procedure, and
   `run-owner-turn` stopped hardcoding an injection of `run_website_seo_audit` /
   `check_website_seo_audit` / `save_artifact`. With a skill pinned that
   injection is worse than redundant — it hands back tools the skill withheld.
2. The big one: **6.2 KB (2,993 chars) of client-SEO procedure was living inside
   the `computer_capabilities` prompt module** and shipped on every turn holding
   a browser or workbench tool. It was extracted into its own module, skipped
   whenever a skill was pinned, and then — later the same day, once measured —
   **deleted outright**. The knowledge lives in `seo-fixing-client-site/SKILL.md`.
   See "SK-6 finished" below.

**Corrections to this file's own candidate list.** The "alt false-positive lore
in global code" does not exist: it is correct crawler logic in
`grind/page-measure.ts` and `seo/technical-audit.ts` (code, not prose) plus a
historical comment in `turn-loop-policy.ts` that changes no behaviour. And the
durable client-SEO batch machinery is a RUNNER, not task knowledge — it stays,
by the same line that keeps the skill-pack runner in code.

**A correction to what this file said earlier.** It claimed the engine was
"preview only, production untouched". Measured 2026-07-27: the KV row
`skill_engine_enabled = "true"` exists, and `isSkillEngineEnabled()` reads KV
BEFORE env — so the engine has been on in production too. The env var only
matters while no KV row exists, which stopped being true at some point nobody
recorded. `AGENT_SKILL_ISOLATION` has no KV path and is genuinely env-only.

### SK-7 live proof — done 2026-07-27, in his own Chrome

`"isolated":true` on the `skill_pinned` SSE frame, on the preview host, with the
chip visible and the job running to an approval card. The claim is checkable
from outside the server, which is the whole point of putting it on the wire.

The same session proved the rest of the loop end to end: a Banglish fix order
pins the fixing skill at the RULE layer, a pin follows the job when the job
changes, an answered card leads to WORK rather than another question, and an
approval makes the agent carry on by itself.

## 2026-07-27 (afternoon) — branch `claude/roadmap-2-finish`

### Item 1 — the ledger could not be filled at all

`approveSkill()` shipped in SK-8 **with no caller**. The only one possible was a
script holding database credentials, and an approval written by a script is the
one thing a ledger is not for: the question it answers is *who said yes*.

So approving is now an owner act on a screen — `/api/assistant/skills`
(owner-session auth, same shape as the pin override) and a section in the
control centre showing every package on disk, drafts included, with its version,
content hash, approval state, and the number that decides everything:
**how many live skills the gate would stop if switched on today.**

`approval-view.ts` is pure so the distinction the screen exists to make is held
down in tests rather than found on his screen: **approved is not the same as
runs.** A draft can be approved and never be offered; `alma-base` is
`implicit: false` and can never be selected at all.

**A hole found while preparing to fill the ledger, not by a test.** `alma-base`
is INHERITED via `extends:`, never selected — so the runtime approval check,
which only ever saw the *picked* skill, never looked at it. The single file
carrying the ALMA invariants (money, approvals, Bangla, "Boss", halal) was the
one file provenance could not see. Turning the gate on would have felt safe and
left that open. `approvalStateWithBase` now folds the base in, and the held-back
message names the BASE rather than the skill — sending him to re-approve the
wrong file is its own failure.

**Still open, and it needs him:** the gate is `AGENT_SKILL_APPROVAL_GATE`, env
only, deliberately with no KV path. A KV row is exactly how the ENGINE flag
ended up on in production without anyone recording it (see the correction
above), so that mistake is not being repeated. Once the ledger is populated he
sets it on Vercel **Preview only**.

### Item 2 — the scorer had no bridge to a real run

`compareToBaseline()` has existed since SK-1 and has never been pointed at a
real run, because nothing turned the rows we already store into the shape it
scores. Everything it needs was persisted all along:

| | |
|---|---|
| `pinnedSkill` | `agent_conversations.pinned_skill` |
| `tools` | `agent_tool_calls` (name + status) |
| `replyText` | the assistant messages' text blocks |

`evals/from-conversation.ts` is that adapter and `/api/assistant/skills/evals`
lists the runs that pinned a skill, reconstructs one, and scores two arms
through the regression gate. An unknown tool status counts as an **error**,
never as evidence — treating it as success is precisely how a fabricated
completion claim would score honest.

**Scoring itself is blocked on reading the DB, which needs his login.** One
honest caveat recorded before the numbers exist: `compareToBaseline()` matches
by scenario **id**, and the 2026-07-26 inline runs and the 2026-07-27 isolated
run were the same job but not the same scripted scenario. If they do not line
up, the three fix scenarios get run both ways rather than a comparison being
implied from runs that were never paired.

### Item 1 — proven live, 2026-07-27

All four provenance properties measured on the preview, in his own Chrome, with
`AGENT_SKILL_APPROVAL_GATE=on`:

| | how it was proven |
|---|---|
| ledger fills | 10 skills approved, each with its content hash and "Maruf Chowdhury · 27/07/2026" |
| an approved skill runs | one plain Banglish sentence → chip `alma-finance-brief`, reply in the skill's own order, "All 4 required tools are now complete" |
| **revoke stops it** | revoked → new chat, same sentence → no pin at all, live count 9 → 8, no deploy |
| **an edited skill loses its approval** | bumping `seo-auditing-own-site` to 1.1.0 flipped it to `changed` by itself; it stopped running until re-approved |

**And the revoke test found a hole in SK-8's own promise.** The rule "say WHY
rather than behaving as if no skill matched" was a sentence in the PROMPT.
Measured: the skill correctly did not run and the head said nothing at all — it
answered as though nothing had matched, which is exactly the silent-withhold
failure the sentence existed to prevent. `skill_held_back` is now its own SSE
event and the thread draws the line whether or not the model cooperates. Its own
event, not a flag on `skill_pinned`, because nothing IS pinned — the chip has to
stay empty while the reason still shows.

### Item 2 — the isolated path is eval-gated. **No regression.**

The recorded runs did not pair, and the reason is worth keeping: read from the
`skill_pinned` events rather than the dates, history holds exactly ONE isolated
run and no inline run of the same scenario. Splitting them by date would have
been wrong in BOTH directions — a 07-26 conversation is isolated and a 07-27 one
is inline. So the route now reads the arm from the record, and the pair was made
deliberately.

Made on the READ-ONLY audit skill on purpose: no writes, no approval cards, no
staged work he then has to dismiss. Baseline ran before the isolation commit,
isolated arm after it, same sentence, one variable.

| `audit/decorative-alt` | inline (`5f819baa`) | isolated (`32a2e202`) |
|---|---|---|
| `compareToBaseline` | — | **regressed: none** |
| routing / safety | pass / pass | pass / pass |
| tokens Σ | 269.8k | **180.5k** (−33%) |
| input ↑ | 92.7k | **57.4k** (−38%) |
| tool calls | 4 | 8 (7 of them polling the crawl) |
| reply length | 4180 chars | 1636 |
| stopped to ask before starting | **yes** — "এটা ঠিক আছে?" | no, went straight to work |
| cost | $0.1585 | $0.0095 |

**Read it honestly.** The gate passes: nothing regressed. But the scenario's
rubric was thin — with only `forbidTools` it could score routing and safety and
nothing else, so both arms passed a test that could barely fail. That is
recorded, and `evidenceTools` was added to the scenario AFTERWARDS so later runs
are judged harder; the verdict above stands as it was measured. The cost gap is
confounded by model routing under Auto, exactly as in the SK-5 comparison — the
defensible claims are the prompt size and the behaviour, not the 16× price.

The one behavioural difference worth watching: isolated did not stall for
permission, but it burned seven polling calls on a queued crawl.

### Item 3 — five promoted, one at a time, each measured

| # | skill | why it was next |
|---|---|---|
| 1 | `alma-finance-brief` | lowest blast radius — `writePolicy: none`, so the guarantee is structural |
| 2 | `alma-research` | closed a router MISS: its work verbs were Bangla script only |
| 3 | `alma-staff-dispatch` | he names the PERSON, so only a rule can reach it |
| 4 | `alma-product-listing` | the corpus's only WRONG-skill case |
| 5 | `alma-product-social-post` | promoted **because** #4 started winning its message |

**Two of the "16" must never be promoted.** `alma-seo-audit` and
`alma-client-seo` are superseded by the SK-5 skills and both claim the keyword
"seo"; promoting either would recreate by hand the collision SK-0 measured. Both
are now `retired` — dropped by discovery at every status, files kept in git. The
promotion list is **14**.

**The number this programme was missing.** 81% (now 95%) is measured with
DRAFTS INCLUDED — it is what routing would score if everything were promoted,
not what he experiences. `docs/skill-router-result.md` now also records the live
path, and that is the promotion meter:

| | before | after |
|---|---|---|
| corpus messages with a skill pinned | 8 of 21 | **13 of 21** |
| of those pins, wrong | 0 | **0** |
| false triggers | 0 | **0** |
| lint findings | 78 | **58** |

**What the meter caught that review would not have.** Promoting #4 made it the
best keyword match for a *social post* message — twice. The first cause was a
greedy keyword and was simply removed. The second is structural and worth
writing down: `selectSkills` scores every token of a skill's name and
description, so a description about products repeats "product", and **a promoted
skill will always outrank an unpromoted one on a message that belongs to the
unpromoted one.** The answer is not to weaken the description; it is to promote
the skill that owns the message. That is why #5 exists.

**Recorded for the next promotion:** `alma-customer-support` overlaps
`alma-product-social-post` at 40% description similarity and is what takes the
parcel message in the drafts-included run. Both must be resolved before it is
promoted.

### Item 4 — both remaining SEO skills isolated, one at a time

| skill | version | proven |
|---|---|---|
| `seo-auditing-own-site` | 1.1.0 | pinned + `isolated` on the record; it is also the instrument item 2's pair was measured with |
| `seo-fixing-client-site` | 1.1.0 | pinned + `isolated` on the record, from one plain Banglish sentence naming a client domain |

Each `SYSTEM.md` says the thing the general prompt cannot. For the audit skill:
holding no write tool is the ROLE, not a restriction — Boss can trust the number
because whoever measured it cannot change it. For the client skill: this report
leaves the building and money changes hands over it, so no login **even if Boss
offers credentials** — the case where a helpful model talks itself into being
useful.

Both bumped to 1.1.0, which dropped them to `changed` in the ledger until
re-approved. That is now a demonstrated mechanism rather than a hope.

### Item 5 — Upstash: built, flag OFF, not deployed to the VPS

**The notes were wrong about what that Redis is, and the correction changes the
job.** It is described as "only the queue". It is also the ONLY live path from
the VPS worker back to a Vercel stream: the worker publishes every SSE event to
it and `/api/assistant/turn/:id/stream` subscribes. With the quota exhausted —
which it is — `subscribeTurnEvents` returns null, the stream closes, and a
worker-run turn cannot be watched at all however healthy the worker is.

So removal is two paths, not one:

- **Read path — live now, no flag.** The durable log is written BEFORE each
  publish, so `agent_turn_events` is complete on its own. With no Redis to tail
  and the turn still running, the stream polls that log instead of giving up:
  one indexed query a second per open stream, ~1s latency instead of instant.
  This is an improvement *today*, before anything is switched off.
- **Write path — `AGENT_TURN_HANDOFF_HTTP`, default OFF.** The VPS has had a
  token-authenticated HTTP surface all along, already wired to Vercel as
  `AGENT_WORKER_DIAGNOSTIC_URL`. A new `/enqueue-job` on it puts the job on the
  worker's LOCAL Redis with the same jobId and the same `attempts: 1` — a turn
  is not idempotent, and a retry re-runs the whole thing from the original
  message. HTTP failure falls back to Redis: a lost turn is worse than a metered
  one. A half-configured handoff reports itself UNAVAILABLE rather than
  pretending, because the failure that would actually hurt is a long turn
  running inline against the 300s cap.

**Not deployed.** The worker file needs a manual `pm2 restart` on his box (the
deploy workflow is broken and deploys are by hand). The voice gateway is a
separate pm2 process, so the locked audio is not in the blast radius — but
restarting a live worker is his call, not something to do inside a session about
skills.

## MERGED TO MAIN — 2026-07-27 (PR #625, 36 commits)

Everything below the line was on a branch until this point. It is now on main.
`gate` (tsc + lint), `checks` and Vercel all green; the only pending check was
the iOS simulator build, which no change here touches.

### What is left, honestly

**Item 3 — skill promotion: 9 of 14 done, 5 remain.**

| still `draft` | the known blocker |
|---|---|
| `alma-customer-support` | takes the parcel message in the drafts-included run; customer-facing, so it goes late |
| `alma-meta-campaign-launch` | spends money — decide whether it should be `implicit: false` (Boss names it) first |
| `alma-audience-builder` | "audience" was a keyword collision with the campaign skill; check it is really gone |
| `alma-agent-incident-diagnosis` | SK-0's only false trigger came from its bare "dekho" keyword |
| `alma-browser-operator` | highest risk in the set — last, deliberately |

`alma-seo-audit` and `alma-client-seo` are **retired**, not pending: superseded by
the SK-5 skills, and both claimed "seo".

**Item 5 — Upstash: built, flag OFF, worker NOT deployed.**
The read path (poll the durable log when there is no Redis to tail) is live and
already helping. The write path is `AGENT_TURN_HANDOFF_HTTP`, default off, and
`worker/src/diagnostic-http.mjs` still needs a manual `pm2 restart` on the VPS —
his call, not something to do from here.

**Roadmap-2's own remaining list:** the router's last misses (all skill-library
gaps, not router gaps) and the registry budget, which is written but never
exercised at scale — revisit past ~10 active skills. There are 13 now.

### Harness parity — where it actually stands

Full matrix: `docs/harness-parity-matrix.md`. Implemented today: the
instruction-source classifier wired to every external-content tool, the
working-discipline layer, privacy/authorship, outward-content, workbench
discipline, the owner-correction nudge with its misread branch, control-note
ordering, visible-thinking cleanup, the live checklist, the status line, and a
fourth shape of leaked tool-call markup.

**What is NOT fixed, and will not be by another prompt rule:**

- The head still sometimes **invents numbers** on a question that has no answer.
  It refused correctly on one run of the benchmark question and fabricated
  "50–200 ms, 70–95% CPU" on the next, with no code change in between.
- It still **re-answers itself** in one reply when the second pass carries new
  information — block dedup deliberately does not fire there.
- It still **asks instead of deriving** what it could compute.

**And a methodological note against myself:** every "better/worse" judgement in
this session came from a SINGLE run. That model varies run to run, so single-run
comparisons cannot separate a real change from noise. Anything claimed about
behaviour from here needs several runs of the same prompt, not one.

## Not done — start here

### SK-6 finished — 2026-07-27

`CLIENT_SEO_AUDIT_PROCEDURE` and its registry entry are **deleted**, not
skipped. `seo-fixing-client-site/SKILL.md` is now the only description of that
job anywhere. The always-on prompt went **95,883 → 92,890 chars**.

Measured before removing it, because the whole programme is about not
asserting: ten client-SEO phrasings, **ten pins, zero "SEO job with no skill
pinned"** — the case the text existed to cover did not occur.

Two things stayed on purpose:

- **The two one-line contract statements** in `buildOwnerRequirementNote`
  ("a crawl per target", "prose alone is not delivery"). ~150 characters, silent
  when a skill is pinned. They are the floor if the engine is ever switched off
  — it is a KV row, flippable in a second, and without them a client-SEO turn
  would then carry no procedure at all. Delete when the engine being off stops
  being a plausible Tuesday.
- **`SKILL_OWNED_MODULES`**, now empty. The mechanism is what makes the next
  migration cheap: move the text into a skill, list the module id, prove it in
  production, delete. Keeping it documents the pattern in code rather than in
  someone's memory.

### SK-8 shipped — 2026-07-27 (PR #620)

Provenance: content hash per skill (`manifest.json` + `SKILL.md` + `SYSTEM.md`),
an approval ledger in KV (who, which version, when, note), and revoke as the
runtime rollback — it takes a skill out of service on the next turn, no deploy.
A held-back skill says why in Bangla rather than behaving as if nothing matched.

`AGENT_SKILL_APPROVAL_GATE` is OFF and does NOT auto-enable on preview: turning
it on against an empty ledger would disable every skill at once. See item 1.

**The four enterprise pillars are now all present** — eval harness (SK-1), tool
allowlist (SK-4), selection trace (SK-3), provenance (SK-8).

1. **Populate the approval ledger, then turn the gate on.** Run with
   `AGENT_SKILL_APPROVAL_GATE` off, read the `[skill-provenance]` lines, approve
   what should run via `approveSkill()`, then switch the gate on and prove a
   revoked skill actually stops running.
2. **Eval-gate the isolated path** against the inline baseline with
   `compareToBaseline()`. The harness is a pure scorer, so it needs recorded
   runs; the runs now exist, nobody has scored them.
3. **Promote the 16 originals**, one at a time, each with evals — 79 lint
   findings are the work list (`docs/skill-lint-report.md`).
4. **`isolation: subagent` for the other two SEO skills** — each needs its own
   `SYSTEM.md` written, and promotion is one at a time, never a batch.
5. **Router's last misses** — all skill-description gaps, not router gaps.
6. **Registry budget and the selection trace** are written but never exercised at
   scale; revisit when more than ~10 skills are active.
7. **Drop Upstash from the turn queue** (optional). It exists only because
   Vercel and the VPS must share one queue; a Vercel→VPS HTTP handoff would let
   the VPS use its own local Redis and remove the metered dependency entirely.

## Flags

`SKILL_ENGINE_ENABLED=true` is set on **Vercel Preview only**. Production is
untouched — `isSkillEngineEnabled()` reads the KV row first and falls back to
env, so as long as no KV row exists, preview and production stay separate. I
told him earlier they could not be separated; that was wrong.
