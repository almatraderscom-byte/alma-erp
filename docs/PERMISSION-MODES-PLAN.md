# Permission & Autonomy Architecture — v2 plan for owner approval (2026-07-27)

**Status: PROPOSAL. Nothing implemented.**
**v1 of this document was too thin — the owner was right on both counts: three
modes is not an enterprise design, and dropping Plan out of the permission axis
was wrong. This is the rewrite.**

Owner's ask: the mode picker in his chat must decide *how much the agent may do
without him*, the way professional agent products do it, and switching the mode
must genuinely change behaviour. Critical actions keep waiting for him in every
mode. This is being built as an enterprise system, not a toy.

---

## 1. Market scan — what a serious permission system actually contains

### 1.1 Claude Code (the reference the owner pointed at)

Two separate mechanisms, not one:

- **Modes** — `default` (ask before shell + significant writes), `acceptEdits`
  (edits auto, shell still prompts), `plan` (read-only: research and propose,
  change nothing), `bypassPermissions` (no prompts; documented as being for
  containers/CI, not a laptop).
- **Rules as code** — `allow` / `ask` / `deny` arrays in `settings.json`, written
  as `Tool(specifier)`: `Bash(npm run test:*)`, `Read(./.env)`, `WebFetch(domain:…)`.
  **Precedence is fixed: deny → ask → allow, first match wins, specificity is
  irrelevant.**
- **A settings hierarchy** — managed(enterprise) > CLI > local > project > user.
  Permission arrays from every scope merge into one effective policy, and **a
  managed deny can never be loosened by anything below it**. Admins can set
  `disableBypassPermissionsMode` and `allowManagedPermissionRulesOnly`.

The lesson: the mode is the *coarse dial*; the rule list is the *fine dial*; the
hierarchy is what makes the whole thing safe in an organisation.

### 1.2 Enterprise human-oversight practice

Three postures, and mature systems use all three at once, chosen per action class:

| Posture | Meaning |
|---|---|
| human-**in**-the-loop | agent prepares, pauses at a policy boundary, human approves before anything external happens |
| human-**on**-the-loop | agent acts, human monitors and can intervene/undo after the fact |
| human-**out**-of-the-loop | fully autonomous, audited by sampling |

Autonomy is granted **per risk class**: full autonomy for reads, conditional for
low-risk writes, mandatory approval for high-risk or irreversible ones. Agents
should also pause on *uncertainty* — low confidence, missing context, unusual
request shape — not only on risk class.

### 1.3 Identity & access practice (the part v1 missed entirely)

Just-in-time privilege elevation is standard in 2026, and its four patterns map
directly onto agent approvals:

1. **time-bounded** — the grant carries an explicit expiry
2. **workflow-attested** — elevation goes through a structured approval
3. **risk-evaluated** — the decision uses signals beyond a human's judgement
4. **auto-revocation** — the grant removes itself on expiry or task completion

Plus **session-scoped grants** (permission tied to the session, dies with it) and
**break-glass** (short emergency window, auto-approved, *elevated* logging, every
action audited). The 2026 guidance explicitly names AI agents as one of the
segments needing per-invocation scoped delegation tokens.

### 1.4 Regulation and frameworks

- **EU AI Act Art. 14** (human oversight) becomes enforceable **2026-08-02**, and
  requires oversight *commensurate with risk, level of autonomy and context* —
  i.e. a per-risk-class ladder, in law.
- **Singapore IMDA Model AI Governance Framework for Agentic AI** (Jan 2026,
  updated May 2026) — the first framework written for autonomous agents. Four
  pillars: bound the risks upfront · make humans meaningfully accountable ·
  technical controls and processes · end-user responsibility. It requires **each
  agent to carry a verifiable identity and an audit trail of which agent acted
  under whose authorisation**, and requires **defined human approval checkpoints
  for higher-risk or irreversible actions**, audited by tracking **human override
  rate and response time**.
- NIST AI RMF / ISO 42001 / EU AI Act converge: one well-designed human-oversight
  control satisfies several at once.

**What this means for ALMA:** the design target is not "a nicer dropdown". It is
*mode + rules + hierarchy + time-boxed grants + identity + audit*, with approval
checkpoints defined per risk class and measured.

---

## 2. What ALMA already has, honestly assessed

| Piece | File | Verdict |
|---|---|---|
| Risk tiers R0–R4 over 15 task families | `autonomy-task-catalog.ts` | **Strong.** reads/research R0 · personal records, memory, drafts R1 · scheduled content, internal reminders R2 · staff & customer messaging, publishing, ads budget, browser, phone calls, finance entries R3 · money movement, security/permissions R4 |
| Staged ladder `off→shadow→suggest→draft→auto_r1→bounded_r2` with a hard ceiling per tier (R3 ≤ draft, R4 ≤ shadow) | `autonomy-rollout.ts` | **Strong.** This is the thing that makes a safe "fast" mode possible at all |
| Deterministic policy kernel, allow/stage/deny with reason classes | `action-policy.ts`, `tool-guard.ts` | **Strong.** Every tool call on every surface goes through it |
| Scope limits: daily count, money cap, quiet hours, canary %, expiry, notify | `autonomy-rollout.ts` | **Strong**, but invisible to him |
| Signed capability envelopes, payload-bound approvals | `capability-token.ts` | **Strong** — this is the "which agent acted under whose authorisation" primitive IMDA asks for |
| Audit log + one-tap undo + daily digest | `autonomy-ledger.ts` | **Strong** — this is what makes an on-the-loop mode possible |
| Execution-style modes (অটো/সরাসরি/প্ল্যান/প্ল্যান-ড্রাইভ), enforced by withholding tools | `chat-mode.ts` | **Good**, but it is a *style* axis that already contains a permission concept (প্ল্যান) — the tangle the owner spotted |
| Owner-configurable rules | `hook-rules.ts` | **Partial.** `block` / `notify` only. **No `allow`, no `ask`, no resource specificity, no precedence, no scope hierarchy** |
| Per-turn read-only authorisation | `turn-authorization.ts` | Good, but derived from message text, not from a mode |

### The twelve gaps

| # | Gap | Evidence |
|---|---|---|
| **G1** | **Plan is not a permission mode.** It lives on the style axis, so "give me a plan and change nothing" cannot be combined with a permission posture | `chat-mode.ts` — owner's own catch |
| **G2** | **No allow/ask/deny rule list.** Cannot say "always allow `get_*`", "always ask before `send_customer_message`", "never `post_to_facebook`" | `hook-rules.ts` has block/notify only, and no resource patterns |
| **G3** | **No "don't ask again".** Every card is one-shot; the same routine approval is asked forever. This is what exhausts him | no session/persistent grant store anywhere |
| **G4** | **No time-boxed elevation and no auto-revocation.** `RolloutScope.expiresAt` exists but is not reachable from chat | `autonomy-rollout.ts` |
| **G5** | **No organisation-policy tier.** Nothing a conversation is forbidden to loosen; no equivalent of managed settings | — |
| **G6** | **Sub-agents escape the turn's context.** `subagent.ts` calls `executeTool(name, input, { conversationId, businessId })` — **no `turnId`, no `instructionOrigin`, no mode.** A delegated specialist therefore bypasses the duplicate guard and would bypass any conversation mode | `models/subagent.ts:204` |
| **G7** | **Unattended surfaces have no declared mode.** Cron/heartbeat/plan-driver rely on the global ladder; nothing states that a chat's mode must NOT leak into them | `tool-guard.ts` derives origin from surface |
| **G8** | **No approval routing.** No timeout/auto-deny policy, no escalation, no second approver, no dual control for R4 money movement | approve route: expiry exists, routing does not |
| **G9** | **The mode is not in the audit trail**, and there is no plain answer to "why did this need my approval / why did this run by itself" | `AgentToolEvent.detail` |
| **G10** | **No approval batching.** One card per item; a 146-product SEO job would ask 15 times | observed live 2026-07-27 |
| **G11** | **No uncertainty gate wired to the mode.** `confidence` exists in the policy request but nothing sets it per mode | `action-policy.ts` |
| **G12** | **Environment drift is silent.** `ladderEnforcementMode()` defaults to `on` for preview and `shadow` for production, and `AGENT_POINT_OF_RISK_ENFORCE` defaults off — so preview and production behave differently and nothing shows it | `autonomy-rollout.ts:301` |

---

## 3. The proposed architecture

### 3.1 Five layers, each able only to TIGHTEN what is above it

```
1. CONSTITUTION        code, immutable, no env override
                       R4 owner-only · untrusted-instruction refusal
                       exactly-once · payload-bound approvals · tier ceilings
                              ↓ can only be tightened
2. ORGANISATION POLICY agent_kv_settings, owner-only, change is itself audited
                       "Fast mode is disabled" · "customer-messaging: never auto"
                       · money cap · quiet hours · per-environment
                              ↓
3. MODE                per conversation, the chip in the composer
                              ↓
4. RULES               allow / ask / deny, Tool(resource) patterns
                       precedence: deny → ask → allow, first match wins
                              ↓
5. GRANT               per decision, at the card: once · this job · 30 min ·
                       always (writes a rule at layer 4)
```

A lower layer may never widen a higher one. This is the Claude Code settings
hierarchy shape, in business terms.

### 3.2 The modes — five, with Plan restored as a first-class permission mode

| Mode | Bangla | Posture | R0 read | R1 draft/memory | R2 schedule/remind | R3 money-adjacent · publish · staff/customer msg · ads · calls · browser · finance | R4 money movement · security |
|---|---|---|---|---|---|---|---|
| **Plan** | প্ল্যান | in-the-loop, nothing executes | ✅ auto | ⛔ **not available** | ⛔ | ⛔ | ⛔ |
| **Careful** | সতর্ক | in-the-loop for everything | ✅ auto | 🟨 card | 🟨 card | 🟨 card | 👤 owner only |
| **Standard** | স্বাভাবিক *(default)* | in-the-loop for risk | ✅ auto | ✅ auto | ✅ auto | 🟨 card | 👤 owner only |
| **Supervised** | তত্ত্বাবধান | **on**-the-loop | ✅ auto | ✅ auto + told after, undo | ✅ auto + told after, undo | 🟨 card, **batched per job** | 👤 owner only |
| **Elevated** | জরুরি অনুমতি | time-boxed JIT grant | ✅ | ✅ | ✅ | 🟨 card, but auto-approve allowed **only** for families he names, **only** for 15/30/60 min, notify-before, undo armed, expiry enforced | 👤 owner only, **never** |

**Read the last column.** In all five modes R4 is owner-only, and that is not a
prompt instruction — `maxStageForTier` caps R4 at `shadow` in the kernel. R3 is
capped at `draft` (= a card) by the same function, and **Elevated** is the single
mode allowed to lift a *named* R3 family, for a *bounded time*, with the grant
auto-revoking. That is the JIT/break-glass pattern, not a bypass: no mode in this
system can move money or change permissions without him.

**Plan mode is a real mode, not a style.** In Plan, world-changing tools are not
in the model's hands at all (the same withholding mechanism `chat-mode.ts`
already uses), so "it planned but also quietly did something" is impossible. It
cannot even stage a card — a card is a request to change the world, and Plan mode
does not make requests. Leaving Plan requires an explicit switch by him.

**Supervised is the mode v1 was missing.** It is the human-**on**-the-loop
posture: routine and medium work runs, he is told afterwards, and every entry is
one-tap undoable via the existing autonomy ledger. It is also where approval
**batching** lives — one card for a whole SEO batch instead of fifteen.

### 3.3 Rules — the fine dial (G2)

Extends `hook-rules.ts` from `block|notify` to the full set, keeping its
fail-open parsing:

```jsonc
[
  { "match": "get_*",                  "action": "allow" },
  { "match": "draft_seo_fixes",        "action": "allow", "scope": "site:almatraders.com" },
  { "match": "send_customer_message",  "action": "ask" },
  { "match": "post_to_facebook",       "action": "deny",  "message": "…" }
]
```

- Precedence **deny → ask → allow**, first match wins, specificity irrelevant
  (copying Claude Code exactly — predictability beats cleverness here).
- `allow` may only widen **within** what the mode and the tier ceiling already
  permit. An `allow` on an R4 tool is inert, by construction.
- Organisation-level rules (layer 2) merge in and cannot be loosened below.

### 3.4 Grants — "don't ask again", done safely (G3, G4)

Every approval card gains a grant selector, the way JIT access works:

| Choice | Lifetime | Effect |
|---|---|---|
| এইবারের জন্য | this action | today's behaviour |
| এই কাজটার জন্য | until the job/plan completes | job-scoped token |
| ৩০ মিনিট | wall clock, auto-revokes | time-bounded |
| সবসময় | writes a layer-4 `allow` rule | visible in a list, revocable in one tap |

Grants are **scoped** (tool + resource + business), **audited**, never applicable
to R4, and every grant is listed on one screen with a revoke button. Expiry is
enforced server-side by the guard, not by the UI.

### 3.5 Making the mode real (the owner's "must sync" requirement)

1. **Server-read, never client-claimed.** The mode lives on the conversation row;
   the turn reads it from the database. A tampered client changes nothing.
2. **Enforced in the guard, not the prompt.** `tool-guard.ts` receives the mode
   in `GuardCallContext`; the model is *told* the mode for tone only. Same lesson
   as listen mode and `chat-mode.ts`: an empty tool list is a guarantee, a
   sentence is a request.
3. **Echoed back.** Every turn reports the mode it actually ran under, and every
   `AgentToolEvent` records `permissionMode` + the deciding layer + rule id (G9).
4. **Inherited downward, never upward (G6).** A sub-agent runs at **min(parent
   mode, its own ceiling)** and receives `turnId` + `instructionOrigin` +
   mode — closing the hole where a delegated specialist escapes both the mode and
   the duplicate guard.
5. **Unattended surfaces are separate (G7).** Cron, heartbeat and plan-driver
   carry their own declared mode (default **Standard**); a chat set to Supervised
   or Elevated never leaks into them.
6. **Environment is visible (G12).** The chip shows when preview and production
   policy differ instead of drifting silently.

### 3.6 Approval routing and dual control (G8)

- Every card carries an expiry and an explicit **on-timeout policy** — default
  `expire` (never auto-approve).
- R4 money movement supports an optional **two-person rule**: owner + one named
  approver. Off by default, available because a business grows into it.
- Notification channel per class (Telegram / ntfy / call), already available.
- **Measured, as IMDA asks:** human override rate and median response time per
  task family, on one dashboard. If he overrides a family constantly, that family
  is at the wrong rung and the number says so.

### 3.7 Uncertainty, not just risk (G11)

`ActionPolicyRequest.confidence` already exists and is unused. Each mode sets a
confidence floor: below it, an otherwise-auto action becomes a card with the
reason *"আমি নিশ্চিত নই"*. Cheap to add, and it is the difference between an agent
that is bounded by category and one that knows when it is out of its depth.

---

## 4. Delivery plan

| Phase | Ships | Gaps closed | Risk |
|---|---|---|---|
| **PM-0** | `permission-mode.ts`: modes, tier→verdict matrix, layer resolution, precedence — pure functions + tests. No wiring | G1 | none |
| **PM-1** | Conversation column, API, composer chip, per-turn echo, mode on every tool event. **Shadow: recorded and shown, nothing enforced** | G9, G12 | low |
| **PM-2** | Enforce Plan and Careful (the two *tightening* modes). Plan withholds every effect tool; Careful cards R1/R2 | G1 | low — tightening only |
| **PM-3** | Rule engine: allow/ask/deny with resource patterns and deny→ask→allow precedence, extending `hook-rules.ts`; org-policy tier that a conversation cannot loosen | G2, G5 | medium |
| **PM-4** | Grants on the card: once / this job / 30 min / always, with server-side expiry, a revoke screen, and no R4 eligibility | G3, G4 | medium |
| **PM-5** | Context inheritance: `turnId` + origin + mode passed to sub-agents; declared modes for cron/heartbeat/plan-driver | **G6, G7** | medium — also fixes a live duplicate-guard hole |
| **PM-6** | Supervised mode: on-the-loop execution wired to the autonomy ledger (told-after + undo) and **approval batching** | G10 | medium |
| **PM-7** | Elevated mode: time-boxed JIT grant per named family, auto-revocation, notify-before, elevated logging | G4 | medium — needs the hardest testing |
| **PM-8** | Governance surface: override rate + response time per family, dual control for R4, timeout policy, "why did this need approval" explainer | G8, G11 | low, additive |

Every phase is live-verified in his Chrome before the next. **PM-5 is worth
pulling early** — it is not only architecture, it is an open hole today.

---

## 5. Explicitly out of scope

- No `bypassPermissions` equivalent. There is no mode, grant, or rule in which
  money moves, a customer or staff member is messaged, the storefront publishes,
  or permissions change without his card. The tier ceiling enforces it in code.
- No change to the call-audio tuning, the ERP, or `/api/agent/*`.
- The existing execution-style modes stay; this is a second, orthogonal axis.

---

## Sources

- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes.md)
- [Claude Code permission rules & settings.json](https://arte.itlibra.com/en/articles/claude-code-permission-rules-settings)
- [Claude Code permissions: settings.json guide for allow/deny/ask](https://www.developersdigest.tech/blog/claude-code-permissions-settings-guide)
- [Human-in-the-Loop AI: When to Gate Agents (2026)](https://explainx.ai/blog/human-in-the-loop-ai-when-to-let-agent-run-2026)
- [Human-in-the-Loop AI Agents: approvals, escalation, safe autonomy in production](https://medium.com/@arvisionlab/human-in-the-loop-ai-agents-how-to-add-approvals-escalation-and-safe-autonomy-in-production-0a21e359781c)
- [JIT Access & Zero Standing Privilege — 2026 Enterprise](https://credentialgovernance.avatier.com/en/blog/just-in-time-access-zero-standing-privilege-2026)
- [Just-In-Time privilege elevation](https://www.securview.com/ai-security-essentials/just-in-time-privilege-elevation)
- [Singapore IMDA: Model AI Governance Framework for Agentic AI](https://www.imda.gov.sg/resources/press-releases-factsheets-and-speeches/press-releases/2026/new-model-ai-governance-framework-for-agentic-ai)
- [Singapore updates the framework, May 2026 (Baker McKenzie)](https://www.bakermckenzie.com/en/insight/publications/2026/06/singapore-updates-model-ai-governance-framework-for-agentic-ai)
- [EU AI Act vs NIST AI RMF vs ISO/IEC 42001](https://trustible.ai/post/ai-governance-frameworks-compared/)
- [Autonomy and Agency in Agentic AI: Architectural Tactics for Regulated Contexts (arXiv)](https://arxiv.org/pdf/2605.12105)
