/**
 * ABAC policy layer (G11 / SPEC-107).
 *
 * Attribute-based rules: a `permit`/`deny` vote conditioned on attributes of the
 * request — principal kind/roles, resource type/id/attributes, and environmental
 * context (channel, risk, time-of-day supplied by the caller). Conditions are a
 * small, serializable, DETERMINISTIC predicate DSL (no code, no LLM, no eval) so
 * a decision can be replayed exactly and the rule set is owner-authorable data.
 *
 * Evaluation order within the layer: the first matching `deny` rule short-circuits
 * to `deny`; otherwise a matching `permit` yields `permit`; if nothing matches the
 * layer `abstain`s (fail-closed — never an implicit permit; INV-05).
 *
 * Pure: no I/O (INV-01). Condition depth is bounded to reject pathological trees.
 */
import { z } from 'zod';
import { principalRoles } from '@/agent/identity/principals';
import type { PolicyLayer, PolicyEvaluationInput, LayerVerdict } from './decision';

export const ABAC_REASON_CODES = {
  RULE_PERMIT: 'ABAC_RULE_PERMIT',
  RULE_DENY: 'ABAC_RULE_DENY',
  NO_RULE_MATCH: 'ABAC_NO_RULE_MATCH',
  MALFORMED_RULE: 'ABAC_MALFORMED_RULE',
} as const;

export type Comparator =
  | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'in' | 'nin' | 'exists' | 'contains';

export interface AttrCondition {
  attr: string; // dotted path, e.g. "resource.attributes.amountNano", "principal.roles"
  op: Comparator;
  value?: unknown;
}
export interface AllCondition { all: Condition[] }
export interface AnyCondition { any: Condition[] }
export interface NotCondition { not: Condition }
export type Condition = AttrCondition | AllCondition | AnyCondition | NotCondition;

export interface AbacRule {
  id: string;
  effect: 'permit' | 'deny';
  /** Applies only to these actions (exact); omit/empty = all actions. */
  actions?: string[];
  when: Condition;
}

/** Max condition-tree depth (rejects pathological nesting; bounded execution). */
export const MAX_CONDITION_DEPTH = 8;

// ── Validation ──────────────────────────────────────────────────────────────

const comparatorSchema = z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'nin', 'exists', 'contains']);
const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ attr: z.string().min(1), op: comparatorSchema, value: z.unknown().optional() }),
    z.object({ all: z.array(conditionSchema) }),
    z.object({ any: z.array(conditionSchema) }),
    z.object({ not: conditionSchema }),
  ]),
) as z.ZodType<Condition>;

export const abacRuleSchema: z.ZodType<AbacRule> = z.object({
  id: z.string().min(1),
  effect: z.enum(['permit', 'deny']),
  actions: z.array(z.string().min(1)).optional(),
  when: conditionSchema,
}) as z.ZodType<AbacRule>;

function conditionDepth(c: Condition, d = 1): number {
  if ('all' in c) return Math.max(d, ...c.all.map((x) => conditionDepth(x, d + 1)));
  if ('any' in c) return Math.max(d, ...c.any.map((x) => conditionDepth(x, d + 1)));
  if ('not' in c) return conditionDepth(c.not, d + 1);
  return d;
}

// ── Attribute resolution ────────────────────────────────────────────────────

/** Resolve a dotted attribute path against the request. Returns undefined if absent. */
export function resolveAttr(input: PolicyEvaluationInput, path: string): unknown {
  // Special virtual attribute: principal.roles (credentials expose scopes here).
  if (path === 'principal.roles') return principalRoles(input.principal);
  const root: Record<string, unknown> = {
    action: input.action,
    principal: input.principal as unknown as Record<string, unknown>,
    resource: input.resource as unknown as Record<string, unknown>,
    context: (input.context ?? {}) as Record<string, unknown>,
    identity: input.identity as unknown as Record<string, unknown>,
  };
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Evaluate one leaf comparison deterministically. */
export function evalComparison(actual: unknown, op: Comparator, expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const a = asNumber(actual), b = asNumber(expected);
      if (a === null || b === null) return false; // non-numeric ordering is a no-match
      return op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b;
    }
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'nin':
      return Array.isArray(expected) && !expected.includes(actual);
    case 'contains':
      if (Array.isArray(actual)) return actual.includes(expected);
      if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected);
      return false;
  }
}

function evalCondition(c: Condition, input: PolicyEvaluationInput): boolean {
  if ('all' in c) return c.all.every((x) => evalCondition(x, input));
  if ('any' in c) return c.any.some((x) => evalCondition(x, input));
  if ('not' in c) return !evalCondition(c.not, input);
  return evalComparison(resolveAttr(input, c.attr), c.op, c.value);
}

// ── Layer ───────────────────────────────────────────────────────────────────

export class AbacLayer implements PolicyLayer {
  readonly name = 'abac';
  readonly version: string;
  private readonly rules: readonly AbacRule[];

  constructor(rules: AbacRule[], version = '1') {
    for (const raw of rules) {
      const parsed = abacRuleSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`invalid AbacRule: ${parsed.error.issues[0]?.message}`);
      if (conditionDepth(parsed.data.when) > MAX_CONDITION_DEPTH) {
        throw new Error(`AbacRule ${parsed.data.id}: condition exceeds max depth ${MAX_CONDITION_DEPTH}`);
      }
    }
    this.rules = Object.freeze([...rules]);
    this.version = version;
  }

  evaluate(input: PolicyEvaluationInput): LayerVerdict {
    const applicable = this.rules.filter(
      (r) => !r.actions || r.actions.length === 0 || r.actions.includes(input.action),
    );
    // Deny rules win: scan for any matching deny first.
    for (const r of applicable) {
      if (r.effect === 'deny' && evalCondition(r.when, input)) {
        return { layer: this.name, effect: 'deny', reasonCodes: [ABAC_REASON_CODES.RULE_DENY, `rule:${r.id}`] };
      }
    }
    for (const r of applicable) {
      if (r.effect === 'permit' && evalCondition(r.when, input)) {
        return { layer: this.name, effect: 'permit', reasonCodes: [ABAC_REASON_CODES.RULE_PERMIT, `rule:${r.id}`] };
      }
    }
    return { layer: this.name, effect: 'abstain', reasonCodes: [ABAC_REASON_CODES.NO_RULE_MATCH] };
  }
}

export function abacLayer(rules: AbacRule[], version = '1'): AbacLayer {
  return new AbacLayer(rules, version);
}
