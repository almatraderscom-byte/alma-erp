/**
 * Agent behavior-artifact versions (Roadmap Phase 0 — AGENT-ARCH-001).
 *
 * Every owner turn is stamped with the versions of the four behavior artifacts
 * that shaped it, so a wrong outcome can be traced to the exact prompt/tool/
 * router/workflow revision that produced it — instead of guessing which of the
 * day's edits was live. BUMP the matching constant in the SAME PR whenever you
 * change the artifact:
 *
 *  - prompt:       src/agent/lib/system-prompt.ts (any behavior-visible edit)
 *  - toolManifest: src/agent/tools/registry.ts / tool-groups.ts (tools added,
 *                  removed, regrouped, or schemas changed)
 *  - router:       src/agent/tools/select-tools.ts / semantic-router.ts
 *                  (selection logic or group profiles changed)
 *  - workflow:     workflow/state-machine layer (none yet — bump from w0 when
 *                  the Phase 4 WorkflowRun engine lands)
 *
 * Format: `<letter><YYYY.MM.DD>[.n]` — date of the change, `.n` for a second
 * bump the same day. No semver ceremony; the value only needs to be comparable
 * by eye in telemetry.
 */
export const AGENT_VERSIONS = {
  prompt: 'p2026.07.15.1',
  toolManifest: 't2026.07.15.1',
  router: 'r2026.07.15',
  workflow: 'w2026.07.15.2',
} as const

export type AgentVersionStamp = typeof AGENT_VERSIONS
