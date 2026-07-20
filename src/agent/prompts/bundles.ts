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

/** SPEC-044 — policy / guardrails bundle (cacheable; stable per policy version). */
export function policyBundle(policyText: string, version = '1'): ContextBundle {
  return { id: 'policy', kind: 'policy', content: policyText, cacheable: true, version };
}

/** SPEC-045 — structured workflow-state bundle (dynamic; breaks the cache prefix). */
export function workflowStateBundle(state: Record<string, unknown>, version = '1'): ContextBundle {
  const content = 'WORKFLOW STATE:\n' + JSON.stringify(state, Object.keys(state).sort(), 2);
  return { id: 'workflow_state', kind: 'workflow_state', content, cacheable: false, version };
}

/** SPEC-046 — relevant memory bundle (dynamic; lowest priority, truncated first). */
export function memoryBundle(items: string[], version = '1'): ContextBundle {
  const content = items.length ? 'RELEVANT MEMORY:\n' + items.map((m) => `- ${m}`).join('\n') : '';
  return { id: 'memory', kind: 'memory', content, cacheable: false, version };
}

/** SPEC-047 — exact tool-schema bundle (dynamic; the tools available this turn). */
export function toolSchemaBundle(schemas: Array<{ name: string; schema: string }>, version = '1'): ContextBundle {
  const sorted = [...schemas].sort((a, b) => a.name.localeCompare(b.name));
  const content = sorted.length
    ? 'AVAILABLE TOOLS:\n' + sorted.map((s) => `${s.name}: ${s.schema}`).join('\n')
    : '';
  return { id: 'tool_schema', kind: 'tool_schema', content, cacheable: false, version };
}

/** SPEC-048 — dynamic request suffix (the user's actual request; always last). */
export function requestSuffixBundle(userText: string, version = '1'): ContextBundle {
  return { id: 'request_suffix', kind: 'request_suffix', content: `USER REQUEST:\n${userText}`, cacheable: false, version };
}
