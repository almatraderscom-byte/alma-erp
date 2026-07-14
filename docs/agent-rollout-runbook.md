# Agent Rollout Runbook (Phase 7 — canary + release discipline)

**Owner-facing, no redeploy needed:** প্রতিটা ধাপ = Vercel dashboard-এ একটা env var বদল + Redeploy বাটন। কোনো ধাপে সমস্যা দেখলে আগের মানে ফিরিয়ে দিলেই আগের আচরণ ফিরে আসে।

## State-router rollout ladder (`AGENT_STATE_ROUTER`)

| ধাপ | env মান | কী হয় | কখন পরের ধাপে |
|---|---|---|---|
| 1. Shadow *(এখনকার prod default — env সেট না করলেও এটাই)* | `shadow` | পুরনো selector-ই চলে; router শুধু ভবিষ্যদ্বাণী করে আর route span-এ log হয় (`detail.shadow`) | ৪৮ ঘণ্টা: shadow prediction-এ ভুল-pack rate কম + কোনো error নেই |
| 2. Canary 10% | `canary:10` | ১০% conversation-এ router সত্যি টুল বাছে (একই conversation সবসময় একই দলে) | ৪৮ ঘণ্টা সবুজ (নিচের স্কোরকার্ড) |
| 3. Canary 25% → 50% | `canary:25`, `canary:50` | ধাপে ধাপে বাড়ানো | প্রতি ধাপে ৪৮ ঘণ্টা |
| 4. Full ON | `true` | সব টার্নে router (≤24 টুল, narrow pack) | — |
| Kill switch | `false` | router সম্পূর্ণ বন্ধ (prediction-ও না) | — |

**কী দেখে সবুজ বলব (প্রতি ধাপে):**
- `agent_tool_events` where `phase='route'`: `detail.shadow.wouldRoute` বনাম আসল ব্যবহার; canary কোহর্টে `router='state'` টার্নগুলোর tool-call fail rate পুরনোটার চেয়ে খারাপ না
- `unknown_tool` / `workflow_blocked` error spike নেই
- Owner correction ("ভুল টুল/আবার প্রথম থেকে") অভিযোগ নেই

## Per-component kill switches (সব env var, `false` = বন্ধ)

| Switch | Component | বন্ধ করলে কী ফিরে আসে |
|---|---|---|
| `AGENT_STATE_ROUTER=false` | State-aware router (P3) | Legacy fixed/dynamic selector |
| `AGENT_WORKFLOW_TEMPLATES=false` | Workflow templates (P5) | Phase 4-এর generic card lifecycle |
| `AGENT_WORKFLOW_GUARDS=false` | Executor guards (P5) | Guard block বন্ধ (bookkeeping hooks চালু থাকে) |
| `AGENT_WORKFLOW_LEASES=false` | VPS job leases (P5) | আগের unleased handout |
| `AGENT_NATIVE_ANTHROPIC_LOOP=true` | One-engine Anthropic adapter (P6) | পুরনো core.ts native loop |
| `AGENT_PROMPT_GATING=false` | Prompt module gating (P6) | সব module সব টার্নে (pre-P6 full prompt) |
| `AGENT_OWNER_INTENT_GATE=false` | Owner-intent mutation gate | Gate + note সম্পূর্ণ বন্ধ |
| `ANTHROPIC_HEAD_DOWN` / `HEAVY_HEAD_MODEL_ID` | Head model (স্থায়ী) | আগের মতোই |

## Permanent PR gate (আপনা-আপনি চলে)

`.github/workflows/agent-gate.yml`: agent-স্পর্শকারী প্রতিটা PR-এ `tsc --noEmit` + `npm run test:agent` (৮৬০+ টেস্ট: manifest coverage, router goldens, workflow transitions, guard/authorization matrix, prompt linter + token budgets) সবুজ না হলে merge নয়। Vercel build এর পাশে এটা দ্বিতীয় required check।

**স্থায়ী নিয়ম (roadmap-এর final principle):** কোনো behavior বদল শুধু প্রম্পট এডিটে ship হবে না — প্রতিটা ভুলের জন্য (১) replay/test case, (২) কোন স্তরের দায় (router/state/schema/handler/prompt), (৩) কোডে invariant, (৪) telemetry, (৫) তারপর প্রম্পট-প্যাচ অপসারণ।

## এখনো বাকি (process, চলমান)
- Phase 0-এর 100-200 আসল replay fixture export (prod DATABASE_URL + PII রিভিউ লাগে) — golden টেস্টগুলো আপাতত deterministic স্তর কভার করে।
- Canary ধাপগুলোর ৪৮-ঘণ্টা গেটগুলো সময়ের সাথে owner/পরের session-এ এগোবে; এই ডকই চেকলিস্ট।
