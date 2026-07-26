# Permission Modes — plan for owner approval (2026-07-27)

**Status: PROPOSAL. Nothing implemented. Owner approves first, then this joins
roadmap-1 as PM-0…PM-5.**

Owner's ask, in his words: he wants the mode picker in his chat to decide *how
much the agent may do without him* — the way Claude Code's permission modes work
— and the mode must genuinely change behaviour, not just a label. In his own
example: in Bypass mode Claude does most things unasked but still stops at the
things that would change production; in Manual mode it asks for everything.

---

## 1. What the market does

| Product | Model |
|---|---|
| **Claude Code** | 5 modes: `default` (ask before bash + significant writes), `acceptEdits` (file edits auto, shell still prompts), `plan` (read-only, propose only), `bypassPermissions` (no prompts — meant for sandboxes), plus `defaultMode` in settings |
| **Enterprise HITL practice** | Three oversight postures: human-**in**-the-loop (agent pauses at a policy boundary), human-**on**-the-loop (agent acts, human monitors and can intervene), human-**out**-of-the-loop (fully autonomous). Production systems are a spectrum, not a switch |
| **The dominant pattern** | Autonomy is granted **per risk class**, not globally: full autonomy for reads, conditional autonomy for low-risk writes, mandatory approval for high-risk/irreversible ones |
| **Regulatory floor** | EU AI Act Article 14 human-oversight duties for high-risk systems become enforceable 2026-08-02, and require oversight *commensurate with risk and level of autonomy* — i.e. exactly a per-risk-class ladder |

**The single most important finding:** every serious system ties the mode to a
**risk classification of the action**, never to a blanket on/off. A "bypass
everything" switch is the one design the field has moved away from, and it is
also the one the owner explicitly does *not* want — he said the critical parts
must still wait for him even in the loosest mode.

Sources are listed at the bottom.

---

## 2. What ALMA already has (this is the good news)

Most of the machinery exists and is live. The gap is that **none of it is
reachable from his chat**.

| Piece | File | What it already does |
|---|---|---|
| Risk tiers R0–R4 per task family | `autonomy-task-catalog.ts` | 15 families: reads/research R0 · personal records, memory, drafts R1 · scheduled content, internal reminders R2 · staff & customer messaging, publishing, ads budget, browser, phone calls, finance entries R3 · money movement, security/permissions R4 |
| Staged autonomy ladder | `autonomy-rollout.ts` | `off → shadow → suggest → draft → auto_r1 → bounded_r2`, with a **hard ceiling by tier**: R3 can never exceed `draft`, R4 can never exceed `shadow` |
| Deterministic policy kernel | `action-policy.ts` + `tool-guard.ts` | Every tool call on every surface passes through it; produces allow / stage / deny with a reason class |
| Scope limits | `autonomy-rollout.ts` | daily count, money cap, quiet hours, canary %, expiry, notify-before/after |
| Execution-style modes | `chat-mode.ts` | `auto / direct / plan / plan_drive`, enforced by **withholding tools**, not by asking the model |

### The two gaps

1. **The ladder does not govern his own chat.** `tool-guard.ts` skips the ladder
   whenever `instructionOrigin === 'owner_direct'` — and everything he types is
   owner-direct. So the ladder currently only governs unattended work
   (heartbeats, plan-driver, autodrive).
2. **Point-of-risk staging for his own R3 writes is shadow-only.** It is behind
   `AGENT_POINT_OF_RISK_ENFORCE`, default OFF, one global env var — not
   per-conversation, not owner-visible, and it needs a redeploy to change.

`chat-mode.ts` says in as many words: *"ONE axis only: execution style.
Approvals stay where they already are… There is deliberately NO 'bypass
permissions' mode."* That decision was right at the time. His ask is to open the
second axis properly — with the critical floor intact.

---

## 3. Proposed design

### Two axes, kept apart

Conflating them is what makes these systems confusing. Claude Code's `plan` mode
is really both axes at once, and that ambiguity is exactly why "did it change
anything?" is a common question there.

- **Axis A — কাজের ধরন (execution style).** Already shipped: অটো / সরাসরি /
  প্ল্যান / প্ল্যান-ড্রাইভ. Unchanged.
- **Axis B — অনুমতি (permission mode).** New. Three levels.

Two chips side by side in the composer, the way Cursor and Copilot separate mode
from auto-approval. (Alternative considered: one merged list. Rejected — it
produces twelve combinations hiding in four labels, and he would lose
plan-drive.)

### The three permission levels

| Mode | Bangla | R0 reads | R1 drafts/memory | R2 scheduling/reminders | R3 money-adjacent, publish, staff/customer messages, ads, calls, browser, finance | R4 money movement, security |
|---|---|---|---|---|---|---|
| **সতর্ক** (Careful) | "সব কিছু আমাকে জিজ্ঞেস করে" | auto | **card** | **card** | card | owner only |
| **স্বাভাবিক** (Standard, default) | "রোজকার কাজ নিজে, ঝুঁকির কাজ আমার অনুমোদনে" | auto | auto | auto | **card** | owner only |
| **দ্রুত** (Fast) | "যতটা পারো নিজে করো, শুধু গুরুত্বপূর্ণটায় থামো" | auto | auto | auto | **card** | owner only |

**Read the R3 and R4 columns across all three rows.** They never change. That is
the whole point, and it is the answer to his "যেন ভুল না করতে পারে": the loosest
mode is *structurally incapable* of publishing, spending, messaging staff or
customers, or moving money without his card, because `maxStageForTier` already
caps R3 at `draft` and R4 at `shadow`. It is not a promise in a prompt — it is
arithmetic in the policy kernel.

So what does **দ্রুত** actually buy him over **স্বাভাবিক**? Two things:
1. **Unattended work rises to the same level as his chat.** Today the ladder
   holds heartbeat/plan-driver work at `draft` for R1/R2 too; in দ্রুত those run
   like his own typed request does.
2. **Fewer interruptions inside a long job.** Batched R1/R2 steps in a
   plan-drive run stop asking one-by-one.

And **সতর্ক** is the mode he switches to when he wants to watch a new capability
before trusting it — every change, even a memory write, comes as a card.

### The sync guarantee (his explicit requirement)

"mode change korle jeno behavior change hoy" — three mechanisms, all server-side:

1. **The server reads the mode, never the client's claim.** Stored on the
   conversation row like `chatMode`; the turn reads it from the DB.
2. **Enforcement is by the guard, not the prompt.** Same lesson as `chat-mode.ts`
   and listen mode: the model is *told* the mode for tone, but the mode is
   *enforced* in `tool-guard.ts`. A model that ignores the sentence still cannot
   act.
3. **Every turn echoes back the mode it actually ran under**, and every
   `AgentToolEvent` records it. If the chip says দ্রুত and the turn ran সতর্ক,
   that is visible, not silent.

### Behaviour when a mode blocks something

The agent must never go vague. It says which mode stopped it and what the choice
is: *"এটা করতে হলে আপনার অনুমোদন লাগবে (সতর্ক মোড)। কার্ড পাঠাব, নাকি মোড বদলাবেন?"*
This is where today's failure mode — silently claiming a card — was hurting him,
so the mode has to be a first-class reason code, not a generic refusal.

### Rules that hold in every mode

- A mode change **never** retroactively approves a card already pending.
- A mode change is itself an audited event (who, when, from → to).
- R4 is owner-only in every mode, with no env override.
- Quiet hours and money caps still apply on top; a mode can only ever be *more*
  restrictive than the ladder ceiling, never less.
- The default for a **new** chat is স্বাভাবিক. দ্রুত is per-conversation and
  never sticky across chats — the loosest setting must be re-chosen deliberately.

---

## 4. Delivery plan

| Phase | What ships | Risk |
|---|---|---|
| **PM-0** | `permission-mode.ts` (pure module: modes, labels, tier→verdict table) + tests. No wiring. | none |
| **PM-1** | Conversation column + API + composer chip + per-turn echo. **Shadow only** — the mode is recorded and displayed, nothing is enforced yet. | low |
| **PM-2** | Enforce for owner-direct writes: সতর্ক cards R1/R2, স্বাভাবিক/দ্রুত keep today's behaviour. R3/R4 untouched (already carded). | medium — this is the one that changes his daily flow |
| **PM-3** | Apply the mode to agent-initiated work: mode sets the ladder floor for unattended runs, with the tier ceiling unchanged. | medium |
| **PM-4** | Audit + explainer: mode on every tool event, and a plain answer to "এটা কেন অনুমোদন চাইল / এটা কেন নিজে করল". | low |
| **PM-5** *(optional)* | Per-family overrides — e.g. দ্রুত everywhere but সতর্ক for staff messaging. | low, additive |

Each phase is live-verified in his Chrome before the next, same as today's work.
PM-2 is the one to test hardest: it is the first phase where a mode can stop
something he asked for directly.

---

## 5. What this does NOT do

- It does **not** add a Claude-Code-style `bypassPermissions`. There is no mode
  in which money moves, a customer is messaged, or the storefront is published
  without his card. He asked for this explicitly and the tier ceiling enforces it.
- It does **not** touch the call-audio tuning, the ERP, or `/api/agent/*`.
- It does **not** replace the existing chat modes.

---

## Sources

- [Claude Code permission modes (docs mirror)](https://code.claude.com/docs/en/permission-modes.md)
- [Claude Code Permission Modes Explained](https://www.explainx.ai/blog/claude-code-permission-modes-explained-2026)
- [Human-in-the-Loop AI: When to Gate Agents (2026)](https://explainx.ai/blog/human-in-the-loop-ai-when-to-let-agent-run-2026)
- [Human-in-the-Loop AI Agents: approvals, escalation, safe autonomy in production](https://medium.com/@arvisionlab/human-in-the-loop-ai-agents-how-to-add-approvals-escalation-and-safe-autonomy-in-production-0a21e359781c)
- [Autonomy and Agency in Agentic AI: Architectural Tactics for Regulated Contexts (arXiv)](https://arxiv.org/pdf/2605.12105)
- [How Much Autonomy Should You Give Your AI Agents? A HITL Playbook](https://ideaforgestudios.com/2026/07/17/human-in-the-loop-ai-agents-autonomy-playbook/)
- [Practicing the Human-in-the-Loop (Strata)](https://www.strata.io/blog/agentic-identity/practicing-the-human-in-the-loop/)
