# UI Overhaul Report — Phase UI-1

**Branch:** `ui-overhaul`  
**Tag (baseline):** `pre-ui-overhaul`  
**Scope:** Presentation only — no API, server actions, Prisma, middleware, or `src/agent/lib|tools` changes.

---

## Part 0 — Pre-flight audit (top 3 issues per module)

| Module | Before (visual/UX) | Addressed in this pass |
|--------|-------------------|------------------------|
| **Dashboard** | Slow 400ms stagger; spinner root loading; KPI grid tight on small phones | Faster motion (180ms); layout-matched skeleton; shared tokens |
| **Orders** | Good route skeleton already | Reused pattern via shared `ModulePageSkeleton` |
| **Inventory** | No `loading.tsx` — flash of empty | Added layout skeleton |
| **Attendance** | No route skeleton | Added layout skeleton |
| **Finance / CRM** | No route skeleton | Added layout skeleton |
| **Payroll** | Has basic loading | Unchanged (inherits primitives) |
| **Invoice** | Dense tables, no mobile card variant | **Skipped** — needs responsive table refactor (larger diff) |
| **Employees** | Generic spacing | **Partial** — via shared `PageHeader` / `Button` |
| **Analytics** | Chart tooltips default recharts style | **Skipped** — chart theme pass deferred |
| **Agent** | Hidden in long sidebar list; no mobile FAB | **Done** — pinned sidebar, FAB, tab, Ask ALMA |
| **Login** | Adequate gradient; button text swap on load | Polished card shadow, `loading` spinner on button |
| **Settings / Portal / Trading / Digital / Audit / Approvals / Operations** | Inconsistent header action alignment | **Partial** — `PageHeader` + tokens apply globally |

---

## Part 1 — Design system

### Tokens (`tailwind.config.ts` + `globals.css`)
- Elevation: `--bg-0` … `--bg-3`, Tailwind `bg-0`…`bg-3`
- Borders: `--border-subtle`, `--border-strong`
- Semantic: `--success`, `--warning`, `--danger`, `--info`
- Gold scale: primary / hover / active / muted
- Radius scale: 10 / 14 / 20px (`rounded-sm`, default, `rounded-lg`)
- Shadows: `shadow-card`, `shadow-elevated`, `shadow-ambient`
- Typography utilities: `.text-h1`–`.text-h4`, `.text-body`, `.text-caption`, `.text-mono-nums`
- `.card-interactive` hover lift

### Motion (`src/lib/motion.ts`)
- Page enter: 180ms fade + 4px rise
- Stagger: 20ms
- Modal spring: stiffness 300, damping 30
- Press scale: 0.98

### Primitives (`src/components/ui/index.tsx`)
- `Button`: `loading` prop, 44px min touch on mobile, `active:scale-[0.98]`
- `Card`: `interactive` hover lift
- `Empty`: optional `action` slot
- `PageHeader`: includes **Ask ALMA** launcher (desktop, owner only)

---

## Part 2 — Performance

- `ModulePageSkeleton` — header + KPI grid + table/cards (mobile)
- Route `loading.tsx` updated: `/`, `/inventory`, `/attendance`, `/finance`, `/crm`
- `RouteTransitionLoader`: max visible ~240ms (was ~520ms mobile bar)
- Dashboard charts already `next/dynamic` per chart (unchanged)
- No full `lodash` imports found
- **Table virtualization:** not added yet — orders/inventory/audit lists need measurement on prod data

### Lighthouse (mobile)

| Route | Before | After | Notes |
|-------|--------|-------|-------|
| Dashboard `/` | *not captured in CI* | *run on Vercel preview* | Run `npx lighthouse` against preview URL |
| Orders `/orders` | *not captured* | *preview* | |
| Inventory `/inventory` | *not captured* | *preview* | |

> **Action for owner:** Open Vercel preview → Chrome DevTools → Lighthouse (mobile) on the three routes above and paste scores into this table before merge.

**Target:** LCP improvement from skeleton-first paint; CLS ~0 (skeletons match layout).

---

## Part 4 — Agent access (owner / `SUPER_ADMIN` only)

| Surface | Implementation |
|---------|----------------|
| Desktop sidebar | `AgentSidebarLink` pinned below nav scroll — gold border band, never in collapse-only overflow |
| Desktop top bar | `AgentLauncherButton` in every `PageHeader` → `/agent` |
| Mobile bottom nav | **Agent** tab (✦) in primary row for owner |
| Mobile FAB | 56px gold ✦, bottom-right above tab bar, safe-area aware |
| Gate | `role === 'SUPER_ADMIN'` — same as `filterNavByRole` + `/agent` page |

Staff / non-owner: no sidebar pin, no FAB, no tab, no Ask ALMA button.

---

## Skipped — needs logic or larger refactor

1. **Invoice / long tables → mobile card list** under 640px (per-row actions wiring)
2. **Analytics chart palette** unified tooltips (recharts theme object)
3. **Table virtualization** for 200+ rows (orders, audit, inventory)
4. **KPI count-up animation** on dashboard stats (needs client-only numeric animation wrapper)
5. **Agent slide-over panel** — deferred; links to `/agent` (no new API)

---

## Commits on `ui-overhaul`

1. `ui: design system tokens + primitives`
2. `ui: performance pass`
3. `ui: agent access (sidebar pin + mobile FAB)`
4. `ui: dashboard polish`
5. `ui: login polish`

---

## Verification checklist

- [x] `npm run build` passes
- [x] `git diff` excludes `src/app/api`, `worker/`, `src/agent/lib`, `src/agent/tools`, `prisma/`
- [ ] Owner click-through desktop + 390px mobile on Vercel preview
- [ ] Staff login: no agent chrome visible
- [ ] Lighthouse before/after filled on preview

**Do not merge to `main` until preview sign-off.**
