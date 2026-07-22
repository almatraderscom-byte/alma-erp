/**
 * Harness Gap 2 — generic deterministic pre/post tool-call hooks.
 *
 * A hook is plain code that runs around EVERY tool execution, for ANY head model
 * (native Claude path in core.ts and the multi-model path in run-owner-turn.ts
 * both call the same runners). Pre-hooks may block a call with an owner-readable
 * message; post-hooks observe the outcome (audit/telemetry). Hooks are
 * deterministic and error-isolated: a throwing hook is skipped (fail-open) and
 * can never break a turn. The AIOS enforcement door stays a separate, dedicated
 * layer — hooks are the generic extension point around it.
 *
 * Gated by AGENT_TURN_HOOKS (default ON — with an empty registry the runners are
 * no-ops, so production behaviour is unchanged until a hook is registered).
 */

export interface PreToolHookContext {
  toolName: string
  input: Record<string, unknown>
  model: string
  personalMode: boolean
  businessId: string
}

export type PreToolHookDecision =
  | { action: 'allow' }
  | { action: 'block'; message: string }

export interface PreToolHook {
  name: string
  run: (ctx: PreToolHookContext) => PreToolHookDecision
}

export interface PostToolHookContext {
  toolName: string
  input: Record<string, unknown>
  model: string
  success: boolean
  error?: string
  durationMs: number
}

export interface PostToolHook {
  name: string
  run: (ctx: PostToolHookContext) => void
}

export function turnHooksEnabled(): boolean {
  return (process.env.AGENT_TURN_HOOKS ?? '').trim().toLowerCase() !== 'false'
}

const preHooks: PreToolHook[] = []
const postHooks: PostToolHook[] = []

export function registerPreToolHook(hook: PreToolHook): void {
  if (!preHooks.some((h) => h.name === hook.name)) preHooks.push(hook)
}

export function registerPostToolHook(hook: PostToolHook): void {
  if (!postHooks.some((h) => h.name === hook.name)) postHooks.push(hook)
}

/** Test seam — clears both registries. */
export function clearTurnHooks(): void {
  preHooks.length = 0
  postHooks.length = 0
}

/**
 * Run all pre-hooks in registration order. First block wins and short-circuits.
 * A throwing hook is skipped (fail-open): guardrails must never take down a
 * normal turn because of their own bug.
 */
export function runPreToolHooks(ctx: PreToolHookContext): PreToolHookDecision {
  if (!turnHooksEnabled()) return { action: 'allow' }
  for (const hook of preHooks) {
    try {
      const decision = hook.run(ctx)
      if (decision.action === 'block') return decision
    } catch (err) {
      console.warn(`[turn-hooks] pre hook "${hook.name}" threw — skipped:`, err instanceof Error ? err.message : err)
    }
  }
  return { action: 'allow' }
}

/** Run all post-hooks; purely observational, every error swallowed. */
export function runPostToolHooks(ctx: PostToolHookContext): void {
  if (!turnHooksEnabled()) return
  for (const hook of postHooks) {
    try {
      hook.run(ctx)
    } catch (err) {
      console.warn(`[turn-hooks] post hook "${hook.name}" threw — ignored:`, err instanceof Error ? err.message : err)
    }
  }
}
