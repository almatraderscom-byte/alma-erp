# Skill Engine V2 — build status

On-demand loadable skills (Claude-Code / open Agent-Skills pattern), the flexible
alternative to the 5 hard-coded `src/agent/lib/skill-packs`. Design source of truth:
`docs/agent-grok-architecture-roadmap.md` → "Skill Engine V2".

A skill makes the agent more **competent**; it never **grants** a capability. Only
approved Alma tools read/mutate data. Auth, approvals, spend limits, secrets, and
completion-proof stay in code — never inside a downloadable skill.

## Phases

- **B1 — foundation (DONE, this file's directory).** Not wired into the live turn yet.
  - `types.ts` — SKILL package format (manifest + metadata + activated skill).
  - `loader.ts` — progressive disclosure: `discoverSkills` (metadata-only, status-gated,
    validates `requiredCapabilities` against an injected known-capability set),
    `selectSkills` (keyword/token routing, ≤3 per turn), `activateSkill` (loads the
    SKILL.md body on demand).
  - `../../skills/alma-owner-daily-briefing/` — first Alma-native skill (status `draft`).
  - Tests: `__tests__/loader.test.ts`.

- **B1-integration (DONE).** `runtime.ts` wired into `run-owner-turn` + `core.ts` +
  `system-prompt.ts` (volatile `activeSkillsBlock`), gated by `SKILL_ENGINE_ENABLED`
  (default OFF). Vercel file-tracing added for `src/agent/skills/**`.
- **B2 (DONE).** The 5 hard packs migrated to SKILL.md packages; `skill-packs/packs.ts`
  + its completion gate kept intact. `skills-integrity.test.ts` drift-guards every
  shipped skill against the live registry.
- **B3 (PARTIAL).** 12 skill packages shipped: owner-daily-briefing, research, seo-audit,
  marketing, website, client-seo, finance-brief, staff-dispatch, customer-support,
  agent-incident-diagnosis, product-social-post, browser-operator. **Queued:**
  meta-campaign-launch, audience-builder, product-listing, invoice-to-erp.
- **B4 (security core DONE).** `import-scan.ts` — static gate: injection/secret/exfil
  scan of prose, danger scan of scripts, Alma import-rule enforcement (pinned commit,
  names-only secrets, mapped capabilities, forced draft) → block/review/ok + contentHash.
  **Remaining (owner-gated workbench wiring):** live commit-pinned fetch, no-secret
  sandbox eval run, shadow→canary→active lifecycle store, one-click rollback.

## Enabling (owner)

The engine is OFF. To try it: set `SKILL_ENGINE_ENABLED=true`, flip a skill's manifest
`status` to `active`, verify selection on a preview, then promote. All skills ship as
`draft` (never auto-active).

## Selection acceptance gates (from the roadmap — enforce as B1-integration lands)

- Correct skill recall ≥98%, precision ≥90%; ≤3 activated skills/turn (normally 1).
- Metadata ≤~100 tokens each at discovery; activated SKILL.md ≤5k tokens.
- A skill cannot expand permissions beyond the current role/workflow, nor add a
  mutating tool after an approval was issued.
