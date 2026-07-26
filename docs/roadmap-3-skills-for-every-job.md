# Roadmap 3 — a skill for every job the agent does

**Owner brief, 2026-07-27.** The SEO programme is the template. He wants the same
treatment for the jobs he needs most, in his words:

> *"ads manager e ads run kora as experts human, erpor computer using skills,
> chrome using skills … thik seo roadmap er moto onk boro kaj … agent ke diye
> audit korabe, er por full audit sesh hole claude agent nijer sathe result
> milabe, er por eta niye skill hobe … erpor claude agent nije full flow ta test
> kore verfiy korbe."*
>
> *"amar target enterprise level, mane ami claude ba chatgpt er moto age shob
> training + Foundation shob thik kore ami market e launch korbo."*

He asked for market research and a recommendation BEFORE any building. This file
is that, and it is the plan of record for the phases after Roadmap 2.

---

## 1. What the research says — and it changes the ORDER

The three surfaces he named are not equally ready. Treating them as one
programme would be the expensive mistake.

### Ads (Marketing API) — ready now, and the industry pattern is settled

The 2026 playbooks agree on a shape, and it is close to what ALMA already does
with approval cards:

- **The agent owns the high-frequency loop** — creative variants, A/B tests,
  budget shifts inside a CBO, pausing fatigued ads. **The human owns the
  low-frequency decisions** — account structure, the offer, spend caps, brand
  approval.
- **Escalate, do not act**, when attribution drifts ~15% from the modelled
  number or a single ad's daily spend crosses the cap.
- **New campaigns land PAUSED** until a human activates them. In Meta's own
  connectors this is deliberate and cannot be flagged off.
- **Start read-only.** The agent proposes for a week, every proposal reviewed;
  write access is earned by demonstrated agreement, expanded incrementally.

→ This maps onto machinery we already have: staged approval cards, the money
guard, `implicit: false` skills that never auto-trigger.

### Computer use — the benchmark number is not the number that matters

- OSWorld went from 12% (Apr 2024) to ~85% (Jun 2026) at the top of the board;
  Claude Sonnet 4.6 scores 72.5% on OSWorld-Verified.
- **But OSWorld 2.0 — long-horizon, median task takes a human 1.6 hours — the
  best frontier system completes 20.6%.**
- And single-run scores hide the thing that decides whether a business can use
  it: **an agent that succeeds once often fails the same task on a repeat run.**

→ Anything long-horizon and unattended on a desktop is a research bet in 2026,
not a product foundation.

### Chrome on his own Mac — the least reliable surface, by a wide margin

- **A 78% WebArena score and ~22% production success rate is the typical gap.**
  Frontier agents measure up to 59% less competent on live sites than static
  benchmarks suggest.
- The six failure modes nobody benchmarks are exactly the ones his Chrome has:
  **DOM selector drift, screenshot ambiguity, login state, modal interruptions,
  rate-limit cliffs, and irreversibility.**
- Independent testing found Chrome's own auto-browse unable to reliably drive
  YouTube Music, Gmail or Sheets.
- The consistent enterprise conclusion: **human-in-the-loop is the architecture
  for high-stakes browser work regardless of how capable models get — the human
  is a designed component, not a fallback.**

→ Use his Chrome for what ONLY his Chrome can do (a logged-in session, a human
eye on a live page), never as a general substitute for an API.

### Skills — his instinct matches where the field landed

- **Evaluation-first**: at least three real evaluation scenarios written BEFORE
  the documentation, run across every model the skill will execute on.
- **Distil skills from real runs**: 2026 work on self-evolving skill libraries
  does exactly what he described — judge whether a trajectory was good enough to
  become a new skill or to refine an existing one.
- **Governance is part of the skill**: version tags (not just commits), a record
  of who approved each version, and skills that encode behavioural boundaries
  and acceptance criteria, not just advice.
- **The harness, not the model, executes**: the model returns a structured call,
  the harness validates schema and permissions, executes, injects the result —
  plus a hard step cap. (This is why the `find_tool` hole found on 2026-07-27
  mattered so much: it was the harness failing to be the boundary.)

---

## 2. Recommendation

**Do them in this order, and do not let the ambition set the order:**

```
1. ADS        — API, auditable, money-gated. Highest value, lowest risk.
2. COMPUTER   — VPS workbench only, short bounded jobs, never long-horizon.
3. CHROME     — narrowest possible scope: logged-in sessions and human-eye
                verification. Last, because production reliability is ~22%.
```

**Two rules to carry into all three:**

- **Money and irreversibility are CODE gates, never skill text.** A skill can
  say "never exceed ৳500/day"; only the server can guarantee it. The 2026-07-27
  lesson stands: a prompt rule is a request, an absent tool is a guarantee.
- **Read-only earns write.** Every new surface starts with a skill that holds no
  write tool, and graduates only when its evals stop regressing.

**On the enterprise target — the honest version.** What separates a demo from
something sellable is not the number of skills; it is the four things underneath
them, and three already exist here in some form:

| | state today |
|---|---|
| eval harness with a no-skill baseline (SK-1) | built, needs recorded runs scored |
| tool allowlist + done gate (SK-4) | built, hole closed 2026-07-27 |
| selection trace + pin + override (SK-3) | built |
| **versioning, approval record, rollback per skill** | **not built — this is the gap** |

Adding the fourth is a smaller job than one more skill, and it is the one a
buyer asks about. Recommend doing it before, not after, the ads programme.

**One correction to the brief.** *"Age shob training + foundation thik kore
launch"* is the right instinct but the wrong sequencing for skills: the research
is consistent that skills must be measured **on our harness with our head
model** — a skill proven elsewhere proves nothing here, and the same model
swings 60.8% → 52.8% between harnesses. So the foundation cannot be finished in
the abstract and then launched; each skill is finished by measurement, one at a
time. Plan for a rolling launch, not a big-bang one.

---

## 3. The pipeline, generalised from SEO

His own description is already the right loop. Written out, per job:

```
A. MEASURE     the agent audits the surface itself (no skill yet) — this is the
               no-skill baseline every later claim is compared against
B. VERIFY      Claude independently checks the agent's result against reality;
               where they disagree, reality wins and the disagreement is the
               most valuable thing produced
C. WRITE       the skill: SKILL.md (≤200 lines) + SYSTEM.md + traps.md, seeded
               from what step B found, plus `done:`, `stop_conditions:`,
               `dependencies:`
D. GATE        ≥3 evals, scored against the step-A baseline; ANY regression
               blocks the skill even if the average improved
E. PROVE       the agent runs the whole flow live, and the owner watches it
```

The SEO programme is the worked example: step B is what turned "52+ images
missing alt" into "zero real defects", and that finding — written into
`traps.md` — is what later let the agent reach the same conclusion in under a
minute instead of a morning.

---

## 4. Phases

### ADS-0 … ADS-4 — the ads expert

| phase | what | gate |
|---|---|---|
| **ADS-0** | The agent audits the ad account itself: structure, active campaigns, spend vs cap, creative fatigue, attribution drift. Read-only. | a written audit + the no-skill baseline recorded |
| **ADS-1** | Claude verifies that audit independently against the Graph API and the owner's own numbers. Every disagreement recorded. | disagreements list — this is the seed of `traps.md` |
| **ADS-2** | `ads-auditing` skill (read-only, holds no write tool). | 3 evals, no regression |
| **ADS-3** | `ads-running` skill — the professional buyer. Owns the high-frequency loop; every write goes through an approval card; spend caps and paused-by-default enforced in CODE. `implicit: false` so it never auto-triggers. | a demonstrated week of proposals the owner agreed with |
| **ADS-4** | The agent runs the full flow live and the owner watches. | live proof, one screenshot per claim |

### CU-0 … CU-3 — computer use (VPS workbench)

Scope deliberately narrow: **short, bounded, repeatable jobs** — data crunching,
file conversion, scripted checks. Explicitly NOT long-horizon desktop work; the
20.6% number above is why.

Same five steps. The extra gate: **each skill must pass its evals on repeated
runs, not once** — repeat-run reliability is the failure the benchmarks hide.

### CH-0 … CH-3 — his Mac's Chrome

Scope: **only what needs a logged-in human session or a human eye.** Anything
reachable by API must go through the API instead — that is a rule in the skill
AND enforced by the tool allowlist.

Extra requirements, straight from the six failure modes:

- every step verified by reading the page back, never by assuming the click
  worked (screenshot ambiguity, DOM drift)
- an explicit login-state check before step 0 (`dependencies:`)
- irreversible actions always behind an approval card
- a hard step cap, and a stop-and-ask on any unexpected modal

---

## 5. What this does NOT promise

- **Not "the agent will never get stuck."** A skill removes the procedural
  stalls; it cannot remove a model deciding badly. The measurable goal is
  completion rate per skill, tracked, improving.
- **Not "benchmark numbers transfer."** Ads via API is deterministic; Chrome is
  ~22% in production. A skill that works in one does not indicate the other.
- **Not "more skills = more capable."** Loading 196 skills scored 29.3% where
  task-conditioned selection scored 45.3%. The library grows one proven skill at
  a time or it gets worse.

---

## Sources

- [The State of Computer Use Agents (2026)](https://medium.com/@adnanmasood/the-hardest-easy-problem-in-ai-the-state-of-computer-use-agents-a7e3aea7fa3a)
- [OSWorld 2.0: Long-Horizon Real-World Tasks](https://arxiv.org/html/2606.29537v1)
- [On the Reliability of Computer Use Agents](https://arxiv.org/pdf/2604.17849)
- [Evaluating Browser-Use Agents in 2026: The Six Failure Modes](https://futureagi.com/blog/evaluating-browser-use-agents-2026/)
- [Browser Agent Reliability — Benchmarks, Hype Gaps and Real Task Performance](https://www.softwareseni.com/browser-agent-reliability-benchmarks-hype-gaps-and-what-real-task-performance-looks-like/)
- [Automate Meta ads with AI agents: a 2026 playbook](https://superscale.ai/learn/how-to-automate-meta-ads-ai-agents/)
- [AI Agents in Meta Ads Manager: What's Real vs. Hype (2026)](https://alexneiman.com/ai-agents-meta-ads-manager/)
- [Agentic Advertising in 2026: The AI Ad-Ops Playbook](https://www.digitalapplied.com/blog/agentic-advertising-2026-ai-ad-ops-playbook)
- [Agent Skill Best Practices: What Most Guides Skip (2026)](https://atlan.com/know/ai-agent/ai-agent-skills/agent-skill-best-practices/)
- [Agent Harness Engineering Guide (2026)](https://qubittool.com/blog/agent-harness-evaluation-guide)
- [MUSE-Autoskill: Self-Evolving Agents via Skill Creation, Memory, Management, Evaluation](https://arxiv.org/html/2605.27366)
- [LH-Bench: Skill-Grounded Evaluation of Long-Horizon Agents on Enterprise Tasks](https://arxiv.org/pdf/2603.22744)
- [Contractual Skills: A GovernSpec Design Framework for Enterprise AI Agents](https://arxiv.org/pdf/2605.22634)
