/**
 * Deterministic fast-path command router (G02 / SPEC-013).
 *
 * Known slash-commands and button payloads resolve to a handler WITHOUT any LLM
 * call (INV-01) — the cheapest, most predictable path. Unknown input falls
 * through to classification (SPEC-015..018). Pure and deterministic.
 */
import type { AdmissionStage } from './gateway';
import type { NormalizedRequest } from './normalize';

/** command token -> deterministic handler id. Extend as commands are added. */
export const FAST_PATH_COMMANDS: Record<string, string> = {
  status: 'handler.status',
  help: 'handler.help',
  ping: 'handler.ping',
  cancel: 'handler.cancel',
  balance: 'handler.balance',
};

export interface FastPathHit {
  handlerId: string;
  command: string;
}

/** Resolve a normalized request to a fast-path handler, or null to fall through. */
export function resolveFastPath(normalized: Pick<NormalizedRequest, 'command'>): FastPathHit | null {
  const cmd = normalized.command;
  if (!cmd) return null;
  const handlerId = FAST_PATH_COMMANDS[cmd];
  return handlerId ? { handlerId, command: cmd } : null;
}

export const fastPathStage: AdmissionStage = {
  id: 'fast-path',
  run(ctx) {
    const normalized = ctx.annotations.normalized as NormalizedRequest | undefined;
    const hit = normalized ? resolveFastPath(normalized) : null;
    return {
      ok: true,
      ctx: { ...ctx, annotations: { ...ctx.annotations, fastPath: hit } },
    };
  },
};
