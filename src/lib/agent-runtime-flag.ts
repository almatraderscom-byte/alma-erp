/**
 * Agent kill-switch flag — NEUTRAL home (audit #7).
 *
 * The AGENT_ENABLED kill switch used to live ONLY inside `src/agent/config.ts`.
 * That meant any ERP-side file wanting to honor the kill switch had to import
 * from `src/agent`, which violates the one-way dependency rule and — per the
 * comment in agent/config.ts itself — "makes the kill-switch unreliable".
 *
 * Putting the flag here, in shared `src/lib`, gives ERP code a sanctioned way to
 * check whether the agent is enabled WITHOUT reaching into the agent module.
 * `src/agent/config.ts` re-exports this, so every existing agent caller keeps
 * working unchanged and there is a single source of truth.
 *
 * This file must never import from `src/agent/`.
 */
export function isAgentEnabled(): boolean {
  return process.env.AGENT_ENABLED === 'true'
}
