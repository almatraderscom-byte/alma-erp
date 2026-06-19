# ALMA ERP + AI Agent — Project Map

High-level structure: major directories, routing, and where tools/workers live.

```
alma-erp/
├── src/                          # Next.js 14 app (App Router) — the ERP + agent web app
│   ├── app/                      # ROUTES (pages + API route handlers)
│   │   ├── (ERP pages)/          # orders, inventory, finance, payroll, employees,
│   │   │                         #   attendance, crm, expenses, operations, trading,
│   │   │                         #   analytics, approvals, invoice, settings, portal …
│   │   ├── agent/                # 🤖 AI agent web UI (chat, memory, studio)
│   │   └── api/                  # ── API route handlers ──────────────────────────
│   │       ├── assistant/        #   ✅ NEW agent API (owner chat). Key routes:
│   │       │                     #     chat/ · conversations/ · memory/ · costs/
│   │       │                     #     actions/ · ask-cards/ · creative-studio/
│   │       │                     #     todos/ · controls/ · transcribe/ · tts/ · internal/
│   │       ├── agent/            #   ⚠️ LEGACY agent API (Hermes Telegram bot / VPS;
│   │       │                     #     X-ALMA-API-KEY + IP allowlist — do not touch)
│   │       │                     #     staff-monitor/ · health-scan/ · brain-stats/ · vps/ …
│   │       ├── (ERP APIs)/       #   orders, inventory, finance, payroll, products,
│   │       │                     #     customers, attendance, hr, dashboard …
│   │       ├── wa/ · telegram/   #   messaging webhooks (WhatsApp / Telegram)
│   │       ├── twilio/ · sms/    #   voice + SMS
│   │       └── cron/ · health/   #   scheduled jobs + health checks
│   │
│   ├── agent/                    # 🤖 AGENT CODE (one-way: agent may import ERP libs, not vice-versa)
│   │   ├── tools/                #   🔧 TOOL DEFINITIONS (the agent's capabilities)
│   │   │   ├── registry.ts       #     central tool registry + handlers
│   │   │   ├── select-tools.ts   #     per-turn tool selection / tool-search deferral
│   │   │   ├── *-tools.ts        #     by domain: erp, finance, staff, cs, ads, marketing,
│   │   │   │                     #       content-engine, brand, qc, salah, reminder,
│   │   │   │                     #       research, personal, orchestrator, diagnostic …
│   │   │   └── __tests__/        #     tool selection + contract tests
│   │   ├── lib/                  #   🧠 CORE ENGINE + intelligence
│   │   │   ├── core.ts           #     the per-turn agent loop (prompt → tools → reply)
│   │   │   ├── system-prompt.ts  #     system prompt assembly (stable + volatile blocks)
│   │   │   ├── agent-memory.ts   #     long-term memory retrieval (pgvector)
│   │   │   ├── conversation-compact.ts  # history compaction (safety valve)
│   │   │   ├── claim-verifier.ts #     honesty guard (verifies tool-claims)
│   │   │   ├── business-snapshot.ts / business-brain.ts  # daily business context
│   │   │   ├── models/           #     model registry + routing (Sonnet brain, opus-gate)
│   │   │   └── intelligence/ · cs/ · ads/ · marketing/ · wa/ · catalog/ · learning/
│   │   ├── components/           #   agent UI (AgentApp, AgentThread, monitor cards …)
│   │   ├── hooks/ · styles/ · types/
│   │
│   ├── lib/                      # Shared ERP libraries
│   │   ├── money.ts              #   whole-taka money math (roundMoney)
│   │   ├── prisma.ts             #   DB client
│   │   ├── agent-api/            #   shared helpers (Dhaka date, business context)
│   │   └── content-engine/ · creative-studio/ · fashn/ · pdf/ · oxylabs/ …
│   ├── components/ · contexts/ · hooks/ · services/ · types/   # shared ERP frontend
│
├── worker/                       # 🛠️ STANDALONE VPS BACKGROUND WORKER (Node + PM2)
│   ├── ecosystem.config.cjs      #   PM2 process config
│   └── src/                      #   long-running / queued jobs (off the Vercel request path):
│       │                         #     telegram · salah · reminders · orders · cs ·
│       │                         #     ads · content-engine · finance · reports ·
│       │                         #     messenger · schedulers · security · memory ·
│       │                         #     diagnostic · intelligence · notify · fashn · tts
│       └── index.mjs             #   worker entrypoint
│
├── prisma/                       # Database
│   ├── schema.prisma             #   models (incl. agent_memory, agent_conversations …)
│   └── migrations/               #   additive migrations
│
├── scripts/                      # one-off / dev scripts (e.g. verify-memory.mjs)
├── docs/                         # phase reports, runbooks, plans (AGENT_FIX_PLAN.md …)
├── gas/                          # Google Apps Script (Sheets integration)
├── android/ · ios/ · mobile/     # Capacitor mobile shells
├── config/ · public/             # deploy config + static assets
└── (root)                        # next.config, package.json, tailwind, tsconfig …
```

## Quick orientation

| Looking for… | Go to |
|---|---|
| The agent's brain / turn logic | `src/agent/lib/core.ts` + `system-prompt.ts` |
| What the agent *can do* (tools) | `src/agent/tools/` (`registry.ts`, `*-tools.ts`) |
| Agent memory (save/recall) | `src/agent/lib/agent-memory.ts`, `conversation-compact.ts` |
| New agent HTTP API | `src/app/api/assistant/*` |
| Legacy Telegram/VPS API (don't touch) | `src/app/api/agent/*` |
| Long-running / queued jobs | `worker/src/*` (runs on VPS, not Vercel) |
| ERP business pages | `src/app/<domain>/` + `src/app/api/<domain>/` |
| Shared money/DB/util libs | `src/lib/` |
| DB schema & migrations | `prisma/` |

**Boundaries (from CLAUDE.md):** agent code lives in `src/agent/`, `src/app/agent/`, `src/app/api/assistant/`. Agent may import ERP shared libs; ERP must never import from `src/agent/`. Long tasks (>30s) go to the `worker/` queue, never Vercel functions.
```
