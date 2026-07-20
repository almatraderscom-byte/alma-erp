/**
 * Context bundle builders (G05 / SPEC-042..048).
 *
 * Each builder produces a typed ContextBundle for one kind. Stable bundles
 * (constitution, skill, policy) are cacheable and form the prompt's cacheable
 * prefix; workflow-state, memory, tool-schema and the request suffix are dynamic.
 * Deterministic, pure. No LLM.
 */
import type { ContextBundle } from '../context/compiler';

/**
 * Default ALMA constitution — the frozen owner-facing runtime rules (Bangla,
 * address the owner as "Boss" only, Islamic guardrails, no emoji in TTS). Owner
 * may override the content; the builder keeps it a stable, cacheable prefix.
 */
export const DEFAULT_ALMA_CONSTITUTION = [
  'You are ALMA, the owner\'s personal business AI.',
  'Speak pure Bangla. Address the owner as "Boss" only — never "Sir".',
  'Islamic guardrails: no haram products or imagery.',
  'No emoji in voice/TTS output. Money is whole-taka BDT; never invent numbers.',
  'Verify every tool result before claiming success.',
].join('\n');

/** SPEC-042 — stable, cacheable constitution (system rules) bundle. */
export function constitutionBundle(content: string = DEFAULT_ALMA_CONSTITUTION, version = '1'): ContextBundle {
  return { id: 'constitution', kind: 'constitution', content, cacheable: true, version };
}

/** SPEC-043 — domain skill instructions bundle (cacheable, stable per skill). */
export function skillBundle(skillId: string, instructions: string, version = '1'): ContextBundle {
  return { id: `skill:${skillId}`, kind: 'skill', content: instructions, cacheable: true, version };
}
