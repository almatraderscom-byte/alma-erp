/**
 * AGENT MODULE — ARCHITECTURE RULE (enforced here, repeat in every agent entry point):
 *
 *   agent code MAY import from ERP shared libs (auth, db client, UI primitives).
 *   ERP code MUST NEVER import from src/agent/.
 *
 * One-way dependency only. Violating this couples the agent to production ERP paths
 * and makes the kill-switch (AGENT_ENABLED) unreliable.
 */

export const isAgentEnabled = () => process.env.AGENT_ENABLED === 'true'
