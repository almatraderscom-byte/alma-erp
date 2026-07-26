# ALMA skill architecture — research-backed plan (v2)

Owner brief, 2026-07-26:

> *"প্রতিটি Skill-এর নিজস্ব System Prompt, Rules, Constraints এবং Execution Logic
> থাকবে … অন্য কোনো অপ্রয়োজনীয় নিয়ম বা আচরণ সেখানে প্রভাব ফেলবে না।"*
>
> *"সেখানে পুরো কাজটি কীভাবে করতে হবে, কোথায় কোথায় আটকে যেতে পারে, কী কী Common
> Mistake হতে পারে … কোন Step-এর পরে কোন Step, Verification কীভাবে হবে, Failure
> হলে কীভাবে Recover করবে — সবকিছুই থাকে।"*
>
> *"Technical Issue ছাড়া অন্য কোনো কারণে যেন Agent কোথাও আটকে না যায়।"*

He asked for market research before a plan. This is that plan.

---

## 1. What the research actually says

Six findings that change the design. Numbers are from the sources at the bottom.

**1. Curated beats generated, by a lot.** Human-curated skills added **+18.2 to
+24.8 points** to pass rates across Claude Code, Codex and Gemini harnesses.
Self-*generated* skills scored **8.1–11.5 points BELOW** the no-skill baseline.
→ His instinct is right: a skill must carry earned experience, not text an LLM
invented about a job it has never done.

**2. Longer is NOT better — and this corrects one thing in his brief.** Compact
skills: **+19.0**. Standard length: **+21.5**. *Comprehensive* documentation:
**+0.7**. Stuffing everything into one file destroys the benefit.
→ Everything he listed (traps, common mistakes, recovery, verification) DOES go
in the skill — but layered: a compact main file that points to deeper files
loaded only when that branch is hit. This is "progressive disclosure", and it is
the single most established pattern in the field.

**3. One skill at a time, chosen per task.** Loading all 196 skills: **29.3%**
pass. Task-conditioned selection: **45.3%**. One skill **+18.0**, two-to-three
**+19.0**, big bundles only **+10.1** — with **23% fewer tokens**.
→ Pin exactly one skill per job. His "server picks and locks it" instinct is
what the data supports.

**4. A portable file does not mean portable behaviour.** The same model scores
**60.8%** in one harness and **52.8%** in another; Claude Opus **61.2% → 53.1%**.
→ A skill copied from the internet is unproven here. Every ALMA skill must be
measured *on our harness, with our head model*, or it is decoration. This is
exactly why his 16 existing skills "শুধু পড়ে আছে".

**5. Skills can make things WORSE.** In SkillsBench, **13 of 87 tasks regressed**
once a skill was added.
→ Every skill change gets eval-gated against a no-skill baseline. No exceptions.

**6. Structure changes behaviour, measurably.** Progressive disclosure raised
distinct skill resources the agent actually opened from **1.18 → 3.85** per run,
effective uptake **1.33 → 3.92**, and passes **+4.1%**. But it was *weaker* where
success depended on exact output conventions, numeric thresholds, or long
generation pipelines.
→ Prose for judgement; **scripts and validators for anything with an exact
answer**. Do not write "title must be 10–70 chars" in prose and hope — validate it.

Plus the field's authoring rules, which our existing skills mostly violate:
description in third person stating *what* AND *when*, main file under ~500
lines, references exactly one level deep, one recommended approach not four, no
time-sensitive text, consistent vocabulary, at least three evals per skill. A
2026 review of 238 real-world skills found **99% carried at least one flaw a
routine review catches**.

---

## 2. The architectural answer to his central question

He wants each skill to have **its own system prompt, its own rules, and no
interference from unrelated rules**. The industry has a precise answer, and it is
not "a bigger skill file":

| | **Skill** | **Subagent** |
|---|---|---|
| What it is | a procedure injected into the *current* context | a separate worker with its **own context window, own system prompt, own tool permissions** |
| Other rules still apply? | **yes** — the big main prompt is still there | **no** — it starts clean |
| Best for | short work, needs the conversation | isolated, heavy, must not be polluted |

**What he described is subagent semantics wearing the word "skill".** A skill
file alone cannot give him "অন্য নিয়ম প্রভাব ফেলবে না" — by construction it sits
inside the main prompt.

**Recommendation: use both, with a clean split.**

> **The skill FILE is the knowledge. The skill RUNNER is the isolation.**
>
> A job runs in a dedicated runner whose system prompt is
> `ALMA invariants (short) + that one skill`, with a tool allowlist and a
> completion gate. The huge general prompt does not come along.

This is the standard shape at every major lab, and — importantly — **we already
have every piece of it**:

| Piece | Where | State |
|---|---|---|
| 16 skill files, frontmatter + steps + tools + guardrails | `src/agent/skills/*/SKILL.md` | written, unused |
| Discovery, keyword selection, prompt injection | `skill-engine/loader.ts`, `runtime.ts` | works, **flag OFF** |
| Isolated runner: own brief, narrowed tools | `models/subagent.ts` `runSubAgent()` | in production |
| Role tool allowlists | `models/specialist-roles.ts` | in production |
| Deterministic completion gate (no "done" without evidence) | `skill-packs/runner.ts` `findGateMisses()` | in production |
| Tool names in packs CI-validated against the registry | `skill-packs/__tests__/packs.test.ts` | working |

Nothing here is a from-scratch build. It is: wire the pieces into one path,
raise the skill format to professional grade, and measure.

---

## 3. The ALMA skill format (v2)

```
src/agent/skills/seo-fixing-own-site/
├── SKILL.md              # ≤200 lines. The procedure. Always loaded when pinned.
├── SYSTEM.md             # the skill's OWN system prompt (role, tone, hard limits)
├── traps.md              # where it got stuck before, and what to do instead
├── recovery.md           # failure → diagnosis → recovery, per known failure
├── verify.md             # how to prove each step really happened
└── scripts/
    └── check_alt.mjs     # deterministic checks — never prose for exact answers
```

Frontmatter, extending what we already parse:

```yaml
name: seo-fixing-own-site
description: >
  Fixes existing on-page SEO problems on almatraders.com — alt text, meta
  descriptions, titles — via owner-approved batches. Use when Boss asks to FIX
  or WRITE SEO content for our own site. Not for producing an audit or report.
version: 2.0.0
extends: alma-base                 # ALMA invariants once, not copied 40 times
tools: [get_website_catalog, audit_product_seo, draft_seo_fixes, submit_to_indexnow]
isolation: subagent                # or `inline` for light skills
done:                              # machine-checkable, not prose
  - tool: audit_product_seo        # every targeted product measured first
  - tool: draft_seo_fixes          # a real approval card exists
  - check: no_finding_left_open
```

Four things this adds over what we have today:

- **`SYSTEM.md`** — the skill's own operating rules, which become the runner's
  system prompt. This is his core ask, and it only works because of `isolation`.
- **`extends: alma-base`** — money, approvals, Bangla, "Boss" never "Sir", halal,
  no live writes without a card. Written once; every skill inherits it. Without
  this, 40 skills drift into 40 dialects of the ALMA rules.
- **`traps.md` / `recovery.md`** — the accumulating experience he actually wants.
  Loaded only when that branch is hit, so they cost nothing on the happy path.
- **`done:`** — becomes the existing completion gate. "হয়ে গেছে" stops being a
  sentence the model can produce at will.

What `traps.md` looks like for the SEO skill on day one — all of it earned today:

```markdown
## অডিটের "৫২টা ছবিতে alt নেই" — মিথ্যা হতে পারে (2026-07-26)
সাজসজ্জার ছবিতে alt="" থাকাই সঠিক, আর aria-label দেওয়া বাটনের ভেতরের ছবিতেও।
লাইভ HTML নিজে গুনে নাও (scripts/check_alt.mjs) — অডিটের সংখ্যা যথেষ্ট নয়।

## Website Supabase কনফিগার না থাকলে সব write টুল মরা
প্রথম ধাপেই যাচাই করো। না থাকলে প্রথম উত্তরেই বলো কোন env নেই — একটার পর একটা
টুলে ধাক্কা খেয়ো না। (সেদিন ১৫ ধাপ আর ১ মিনিট ৩৬ সেকেন্ড নষ্ট হয়েছিল।)

## ৫০টা প্রোডাক্ট একসাথে নয়
১০টার ব্যাচ, প্রতি ব্যাচে একটা approval card। বড় ব্যাচ টার্নের সময়সীমায় মরে।
```

---

## 4. Runtime: select → pin → announce → isolate → gate

1. **Select** — the server picks the skill *before* the model runs. Selection is
   a short deterministic decision list (verb + target + `when_not_to_use`), not
   keyword scoring alone, because keywords cannot separate "audit it" from
   "fix it" — which is precisely the bug that cost a day this week.
2. **Pin** — the choice sticks to the conversation. One chat, one job. This is
   also the cost fix: a 5k-token skill re-picked every turn destroys the prompt
   cache (his own meter showed what that costs); pinned, it is one cache write.
3. **Announce** — the head's first line names the skill, and a chip shows it in
   the UI next to the model picker. He can change it — that is the override when
   selection is wrong.
4. **Isolate** — for `isolation: subagent`, the job runs with
   `alma-base + SYSTEM.md + SKILL.md` and the skill's tool allowlist. **The
   allowlist is the real enforcement.** A read-only audit skill is handed no
   write tool, so it cannot write no matter what it decides. Everything this
   session proved says the same thing: a prompt rule is a request, an absent tool
   is a guarantee.
5. **Gate** — `done:` is checked against actual tool records. Unmet → the turn
   reports what is left, never "হয়ে গেছে".

His literal ask — *"first reply-তে skill-এর নাম না বললে server আটকে দেবে"* — is
kept as the announcement check, but softened to one in-place repair rather than
killing the turn. Blocking catches only the sentence; the allowlist catches the
behaviour.

---

## 5. Build order

Eval-first, because finding 5 says skills can regress things.

| Phase | What | Gate to pass |
|---|---|---|
| **SK-0** | **Measure today's reality.** Flip `skill_engine_enabled` ON in preview, run ~20 of his real messages, record picked-vs-correct and completion. No code. | a hit-rate table |
| **SK-1** | **Eval harness.** 3 scenarios per skill, each runnable with and without the skill. | baseline numbers exist |
| **SK-2** | **Format v2 + `alma-base`.** Schema, loader support, a linter for the 99%-of-skills flaws (description person/what+when, length, reference depth, tool names exist). | linter green on all skills |
| **SK-3** | **Select → pin → announce.** Deterministic router, conversation pin, UI chip + override. | right skill on ≥90% of the SK-0 set |
| **SK-4** | **Isolate + allowlist + gate.** Route `isolation: subagent` skills through `runSubAgent`; wire `done:` into the existing pack gate. | audit skill provably cannot write |
| **SK-5** | **Write the three SEO skills properly**, with `traps.md` seeded from this week. | beats no-skill baseline on evals |
| **SK-6** | **Move the global hacks into skills** and delete them from global code. | tests stay green |

`alma-seo-base` → `seo-auditing-own-site` (read-only) → `seo-fixing-own-site`
(write via approval card) → `seo-fixing-client-site` (no DB, PR/report only).
Naming follows the field convention: gerund, lowercase, hyphens.

---

## 6. What stays global, deliberately

Skills own **task knowledge**. Global code keeps only what is true for every
task: money and approval gates, honesty/claim verification, Bangla and "Boss",
the turn loop (don't stop mid-step, self-continue, deadline handling), and the
capability preflight. Those are not procedures — they are what the agent *is*.

**The rule this buys:** if I am about to edit a regex or a policy file to make
*one job* behave, that is the signal it belongs in a skill instead. That is the
direct answer to his complaint, and it is a rule about how I work, not a feature.

---

## 7. Honest limits

- **"কোথাও আটকাবে না" is a target, not a guarantee.** A skill removes the
  *procedural* stalls — the wrong-turn, the forgotten step, the fake "done", the
  15-step discovery of a dead connection. It cannot remove a model deciding
  badly. The measurable goal is completion rate per skill, tracked, improving.
- **Skills cost tokens.** Pinning + progressive disclosure keeps it to roughly
  one cache write per conversation. If a skill's main file grows past ~200 lines,
  that is a signal to split it, not to accept the cost.
- **A wrong skill is worse than none** — it removes the tools the real job
  needed. Hence: the chip is always visible and always overridable, and a skill
  that finds itself missing a tool must say so plainly.
- **This will take weeks, not days,** if done to the standard he is asking for.
  SK-0 through SK-2 is the honest first slice.

---

## 8. What to approve first

**SK-0 and SK-1 together** — turn the flag on in preview, run his real messages,
and build the eval harness. No merge, no new architecture, and it produces the
one thing every later decision depends on: *do the skills we already have
actually get picked and actually help?*

Given finding 5, doing anything else first would be guessing.

---

## Sources

- [Skill authoring best practices — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [How to write effective AI agent skills: 6 data-backed practices — Arize AI](https://arize.com/blog/how-to-write-effective-ai-agent-skills/)
- [SkillJuror: Measuring How Agent Skill Organization Changes Runtime Behavior](https://arxiv.org/pdf/2606.11543)
- [Agent Skills: A Data-Driven Analysis of Claude Skills](https://arxiv.org/pdf/2602.08004)
- [Skills explained: Skills vs prompts, Projects, MCP, and subagents — Anthropic](https://claude.com/blog/skills-explained)
- [Claude Code Subagents vs Skills: When to Use Each](https://theaiarchitects.com/blog/claude-code-subagents-vs-skills)
- [Agent Skill Best Practices — Atlan](https://atlan.com/know/ai-agent/ai-agent-skills/agent-skill-best-practices/)
- [Testing Agent Skills Systematically with Evals — OpenAI](https://developers.openai.com/blog/eval-skills)
- [A practical guide to building agents — OpenAI](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
