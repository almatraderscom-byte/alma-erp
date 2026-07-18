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

- **B1-integration (NEXT).** Wire discovery+selection into `run-owner-turn` / the
  modular prompt compiler (`system-prompt.ts`): inject the ≤3 activated skill bodies
  into the volatile block; feed the live tool registry as `knownCapabilities`; reuse
  the deterministic completion-gate from `skill-packs/runner.ts`.
- **B2.** Migrate the 5 hard packs (research/seo/marketing/website/client_seo) into
  this format — keep their completion gates.
- **B3.** Author the first ~12 Alma-native skills (see roadmap list).
- **B4.** GitHub import policy: pin commit → scan (injection/secrets) → map to Alma
  capabilities → no-secret sandbox eval → shadow → canary → active; one-click rollback.

## Selection acceptance gates (from the roadmap — enforce as B1-integration lands)

- Correct skill recall ≥98%, precision ≥90%; ≤3 activated skills/turn (normally 1).
- Metadata ≤~100 tokens each at discovery; activated SKILL.md ≤5k tokens.
- A skill cannot expand permissions beyond the current role/workflow, nor add a
  mutating tool after an approval was issued.
