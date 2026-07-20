/**
 * Request source normalization (G02 / SPEC-012).
 *
 * Collapses the different inbound shapes (Telegram, assistant API, internal
 * cron) into one `NormalizedRequest`. Deterministic; rejects unknown channels
 * and oversized text fail-closed. Registered as the first admission stage.
 */
import { REASON_CODES, failure } from '@/agent/contracts';
import type { AdmissionStage } from './gateway';

export const KNOWN_CHANNELS = ['telegram', 'assistant', 'cron', 'internal'] as const;
export type Channel = (typeof KNOWN_CHANNELS)[number];

export interface NormalizedRequest {
  channel: Channel;
  text: string;
  command: string | null; // leading /command token, lower-cased, if present
  hasAttachments: boolean;
}

/** Max normalized text length accepted at admission (8 KiB of characters). */
export const MAX_TEXT_LEN = 8 * 1024;

export function normalize(input: {
  channel: string;
  text?: string;
  command?: string;
  payload?: unknown;
}): { ok: true; normalized: NormalizedRequest } | { ok: false; reason: string } {
  const channel = input.channel?.toLowerCase();
  if (!KNOWN_CHANNELS.includes(channel as Channel)) {
    return { ok: false, reason: 'UNKNOWN_CHANNEL' };
  }
  const text = (input.text ?? '').trim();
  if (text.length > MAX_TEXT_LEN) return { ok: false, reason: 'OVERSIZED' };

  const explicit = input.command?.trim().toLowerCase();
  const derived = text.startsWith('/') ? text.slice(1).split(/\s+/)[0].toLowerCase() : null;
  const command = explicit ? explicit.replace(/^\//, '') : derived;

  const hasAttachments =
    typeof input.payload === 'object' &&
    input.payload !== null &&
    Array.isArray((input.payload as Record<string, unknown>).attachments) &&
    ((input.payload as Record<string, unknown>).attachments as unknown[]).length > 0;

  return { ok: true, normalized: { channel: channel as Channel, text, command: command ?? null, hasAttachments } };
}

export const normalizeStage: AdmissionStage = {
  id: 'normalize',
  run(ctx) {
    const r = normalize(ctx.input);
    if (!r.ok) {
      const code = r.reason === 'OVERSIZED' ? REASON_CODES.OVERSIZED_INPUT : REASON_CODES.MALFORMED_INPUT;
      return { ok: false, failure: failure('FAILED_FINAL', [code]) };
    }
    return { ok: true, ctx: { ...ctx, annotations: { ...ctx.annotations, normalized: r.normalized } } };
  },
};
