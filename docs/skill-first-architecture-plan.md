# Skill-first agent — architecture plan

Owner proposal, 2026-07-26. His words, and they are the whole brief:

> *"tmi ashole jevabe agent ke train up korteso, eta amr mote onno dik er kaj
> bhenge dicche … evabe agent ke shikhate gele amr onno kono feature er moddhe
> effect holew tmi sheta bujhbe na. eta professional ba smart way na."*
>
> *"ami cai amr agent ke custom skill shikhabo — ami kono task dile agent age oi
> skill ta pore same instruction follow kore kaj korbe, r agent shuru tei bole
> nibe je ami oi skill ta use korchi … server side theke agent er first reply te
> skill er nam na bolle server take atke dibe."*

He is right, and today proved it. Fixing "a fix order is not an audit order"
meant editing a global regex; fixing "don't stop mid-step" meant editing the
global turn loop, which broke a test written for a different feature yesterday.
Neither change is visible to anyone reading the SEO work, and neither can be
reasoned about locally. Task knowledge does not belong in global code.

---

## 1. What already exists (do not rebuild it)

| Piece | Where | State |
|---|---|---|
| 16 skills as markdown + manifest | `src/agent/skills/*/SKILL.md` | written, unused |
| Discovery + keyword selection (≤3 per turn) | `skill-engine/loader.ts` | working |
| Prompt injection of the chosen skill | `skill-engine/runtime.ts` | working |
| Kill switch, no redeploy | `skill_engine_enabled` KV / `SKILL_ENGINE_ENABLED` | **OFF** |
| Hard playbooks with a deterministic completion gate | `skill-packs/packs.ts`, `runner.ts`, `complete_skill_pack_run` | separate, older |
| Tool names in packs validated against the live registry by CI | `skill-packs/__tests__/packs.test.ts` | working |

A SKILL.md today already carries: name, description, keywords, numbered steps
with the exact tools per step, a checklist, guardrails, and a "Done" definition.
That is most of the shape he described.

**So this is not a build-from-zero project.** It is: turn it on, make the
selection trustworthy, make the agent announce it, enforce it server-side, and
move task knowledge out of global code and into the skill files.

---

## 2. The five gaps between what exists and what he asked for

1. **The agent never says which skill it is using.** No announcement, no UI chip.
2. **Nothing enforces it.** The skill is advice in the prompt; the head may
   ignore it and no one notices.
3. **Selection is keyword-scored, so it cannot tell audit from fix.** This is
   exactly today's bug in a different costume: `alma-seo-audit` and
   `alma-client-seo` both match "seo", and nothing decides between "audit it"
   and "fix it".
4. **Skills hold the happy path, not the traps.** They say what to do; they do
   not say where the agent got stuck last time, which is the knowledge he
   actually wants to accumulate.
5. **"Done" is prose, not a gate.** `skill-packs` has a real completion gate;
   `skill-engine` does not. Two systems, one of them enforceable.

---

## 3. The plan, in the order I would do it

Each phase is independently useful and independently revertible. He approves one
at a time; nothing merges without a live check in his Chrome.

### SK-0 · Measure before changing anything (half a day, no code)

Turn `skill_engine_enabled` ON in **preview only**, then run 15–20 real messages
he would actually send and record which skill got picked and whether it was the
right one. Output: a hit-rate table.

Why first: it tells us whether selection needs a small fix or a redesign, and it
costs nothing but time. If keyword selection turns out to be 90% right, SK-3
shrinks a lot.

### SK-1 · The server picks, pins, and announces the skill

- The **server** decides the skill before the model runs, not the model.
- The chosen skill is **pinned to the conversation**, not re-picked every turn.
  Two reasons: it matches how he works (one chat = one job), and re-injecting a
  different 5k-token block every turn breaks the prompt cache — see §5.
- The head's first line must state it: *"alma-seo-fix skill ব্যবহার করছি।"*
- The UI shows a chip beside the model picker: `🧠 alma-seo-fix`. He can see it
  and change it, which is also the manual override when selection is wrong.

### SK-2 · Enforcement, the version that actually works

His ask: *"first reply-তে skill-এর নাম না বললে server আটকে দেবে"*. The literal
version — let the model choose, then block it — costs a wasted round and only
catches the announcement, not the behaviour. Stronger, same spirit:

- **The tool list is cut to the skill's allowlist.** This is the only enforcement
  that has ever held in this codebase: an absent tool is a guarantee, a prompt
  rule is a request. `alma-seo-audit` gets no write tools at all; `alma-seo-fix`
  gets `audit_product_seo` + `draft_seo_fixes` and nothing else.
- **The announcement is checked once**, and a missing one is repaired in place
  (one retry) rather than failing the turn.
- **The skill's `Done` list gates completion**, reusing the existing skill-pack
  gate: the head cannot say "হয়ে গেছে" until every required step has a
  successful tool record.

### SK-3 · Skill file schema v2 — where the real value is

Add to the frontmatter, keeping v1 files valid:

```yaml
when_to_use:     "মালিক বিদ্যমান SEO সমস্যা ঠিক করতে বললে"
when_not_to_use: "নতুন অডিট/রিপোর্ট চাইলে → alma-seo-audit"
tools:           [audit_product_seo, draft_seo_fixes, submit_to_indexnow]
extends:         alma-seo-base        # ALMA rules once, not in 40 files
```

And a new body section that is the point of the whole exercise:

```markdown
## যেখানে আগে আটকেছি
- অডিটের "৫২টা ছবিতে alt নেই" মিথ্যা ছিল — সাজসজ্জার ছবিতে alt="" থাকাই নিয়ম।
  আগে লাইভ HTML দেখে গুনবে, অডিটের সংখ্যায় বিশ্বাস করবে না। (2026-07-26)
- Website Supabase কনফিগার না থাকলে সব write টুল মরা — প্রথম ধাপেই যাচাই করবে।
- ৫০টা প্রোডাক্ট একসাথে নয়; ১০টার ব্যাচ, প্রতি ব্যাচে approval card একটা।
```

`extends` matters: without it, every ALMA rule (money, Bangla, "Boss" not "Sir",
halal, approval gates) gets copy-pasted into every skill and they drift apart.

### SK-4 · Split the SEO skills the way he described

```
alma-seo-base          ALMA rules + what SEO means here (never selected alone)
├── alma-seo-audit     read-only. own site. no write tool exists in its list
├── alma-seo-fix-own   almatraders.com. write via draft_seo_fixes → approval card
└── alma-seo-fix-client  a customer's site. no DB access; produces a PR/report
```

Selection between them is a **short deterministic decision list inside the skill
router** — the verb decides, and `when_not_to_use` is the tiebreak. That decision
lives in one readable place instead of a regex buried in
`owner-turn-requirements.ts`.

### SK-5 · Observability, so he can see whether a skill works

Every turn logs: skill, version, steps attempted, steps completed, stop reason,
tokens, cost. One page: *"alma-seo-fix — 7 runs, 5 completed, stuck twice at step
3 (draft_seo_fixes validation)"*. That table is what tells him which skill to
improve next, instead of guessing.

### SK-6 · Move today's hacks out of global code

Once SK-1..SK-4 hold, the global patches I added for SEO come out and go into the
skill files where they belong:

- fix-vs-audit intent regex → `when_to_use` / `when_not_to_use`
- the alt false-positive lore → `## যেখানে আগে আটকেছি`
- the SEO-specific parts of the client-seo batch contract → skill `Done` list

What STAYS global, deliberately: money, approvals, honesty/claim verification,
Bangla output, the "don't stop mid-step" loop rule. Those are not task knowledge;
they are what the agent is.

---

## 4. The rule this whole thing buys us

**From here on: task knowledge goes in a skill file. Global code changes only for
things that are true for every task** — safety, money, honesty, language, the
turn loop itself. If I am about to edit a regex to make one job behave, that is
the signal that it belongs in a skill instead.

That is the answer to his complaint, and it is worth writing down because it is a
rule about how I work, not a feature.

---

## 5. The two risks worth naming up front

**Cost.** A skill body is ~5k tokens injected into the system prompt. Injected
*volatilely* — different skill per turn — it breaks the prompt cache prefix, and
his own cost analysis already showed what that does (~$0.17/turn). Pinning the
skill per conversation (SK-1) is the mitigation: one cache write at the start of
the chat, cache hits for every turn after. This is why pinning is in SK-1 and not
an afterthought.

**Wrong skill picked.** A wrong skill is worse than no skill, because it comes
with an allowlist that removes the tools the job actually needed. Mitigations:
the chip is always visible and always changeable by him; a skill may declare
`escalates_to`; and if the head needs a tool the skill withheld, it must say so
plainly rather than working around it — the capability-preflight block shipped
today already does exactly this.

---

## 6. What I recommend he approves first

**SK-0 alone.** One preview flag, 20 messages, a hit-rate table, no code, nothing
merged. Everything after it becomes a much better-informed decision — including
whether SK-3 is a small edit or a real project.
