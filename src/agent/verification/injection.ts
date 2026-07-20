/**
 * Prompt-injection detection (G19 / SPEC-188).
 *
 * Untrusted text (a customer message, a web page, a tool result) may try to hijack
 * the agent — "ignore previous instructions", "you are now DAN", "reveal your API
 * key", smuggled tool calls. This deterministic detector FLAGS such text so the
 * head treats it as data to summarise, never as instructions to obey. It does not
 * rewrite; it labels. Pure regex, no LLM (INV-01) — a detector that needed the
 * model to judge injections would itself be injectable.
 */
export interface InjectionFinding { flagged: boolean; hits: string[] }

export const INJECTION_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'ignore_instructions', re: /\b(ignore|disregard|forget)\b[^.]{0,30}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\b(instruction|prompt|rule|context)/i },
  { id: 'role_override', re: /\byou are now\b|\bact as\b[^.]{0,20}\b(dan|jailbreak|unrestricted)\b|\bpretend to be\b/i },
  { id: 'system_spoof', re: /(^|\n)\s*(system|assistant)\s*:/i },
  { id: 'exfiltrate_secret', re: /\b(reveal|show|print|send|leak|share)\b[^.]{0,30}\b(api[_\s-]?key|secret|password|token|credential|system prompt)\b/i },
  { id: 'tool_smuggle', re: /<\/?tool_call>|```tool|\bcall the\b[^.]{0,20}\btool\b[^.]{0,20}\bwith\b.*\b(admin|owner|delete|refund)\b/i },
  { id: 'override_guardrail', re: /\b(disable|bypass|turn off|override)\b[^.]{0,30}\b(guardrail|safety|policy|approval|filter)\b/i },
];

/** Flag injection attempts in untrusted text. Deterministic. */
export function detectInjection(text: string): InjectionFinding {
  const hits = INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.id);
  return { flagged: hits.length > 0, hits };
}
