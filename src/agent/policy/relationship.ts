/**
 * Relationship authorization layer (G11 / SPEC-108).
 *
 * ReBAC (relationship-based access control, Zanzibar-style): authorize by the
 * relationship between the PRINCIPAL and the specific RESOURCE INSTANCE, not by
 * role or attribute. Access is expressed as relation tuples `(subject, relation,
 * object)` — e.g. `(human:maruf, owner, order:o-1)`, `(human:s1, member,
 * team:sales)`, `(team:sales, manager, order:o-1)`.
 *
 * A `RelationRequirement` maps `(action, resourceType)` to the relations that
 * grant it. The layer votes `permit` if the principal holds any required relation
 * to the resource — directly, or through ONE bounded group hop (member→group,
 * group→relation→object) — and `abstain` otherwise (fail-closed; another layer
 * may still permit, else the engine denies). Explicit `deny` relations veto.
 *
 * Pure, deterministic, bounded traversal (no I/O, no LLM; INV-01).
 */
import type { Principal } from '@/agent/identity/principals';
import type { PolicyLayer, PolicyEvaluationInput, LayerVerdict } from './decision';

export const REL_REASON_CODES = {
  RELATION_GRANTED: 'REL_RELATION_GRANTED',
  RELATION_DENY: 'REL_RELATION_DENY',
  NO_RELATION: 'REL_NO_RELATION',
  NO_RESOURCE_ID: 'REL_NO_RESOURCE_ID',
} as const;

/** A relation tuple. subject/object are `type:id` refs (e.g. "team:sales"). */
export interface RelationTuple {
  subject: string;
  relation: string;
  object: string;
}

/** Which relations grant (or veto) an action on a resource type. */
export interface RelationRequirement {
  /** Applies to these actions (exact); omit/empty = all actions. */
  actions?: string[];
  resourceType: string;
  /** Holding ANY of these relations to the resource permits. */
  permitRelations: string[];
  /** Holding ANY of these relations to the resource explicitly denies (veto). */
  denyRelations?: string[];
}

/** The subject ref for a principal (tenant already isolated by the engine). */
export function principalRef(p: Principal): string {
  switch (p.kind) {
    case 'human': return `human:${p.actorId}`;
    case 'agent': return `agent:${p.agentId}`;
    case 'workflow': return `workflow:${p.workflowId}`;
    case 'credential': return `credential:${p.credentialId}`;
  }
}

/** Max group indirection hops (member→group→object). Bounded to keep it O(1)-ish. */
export const MAX_GROUP_HOPS = 1;

export class RelationshipLayer implements PolicyLayer {
  readonly name = 'relationship';
  readonly version: string;
  /** subject → object → Set<relation> (direct). */
  private readonly direct = new Map<string, Map<string, Set<string>>>();
  /** subject → Set<group> where (subject, member, group). */
  private readonly memberships = new Map<string, Set<string>>();
  private readonly requirements: readonly RelationRequirement[];
  private readonly maxGroupHops: number;

  constructor(
    tuples: RelationTuple[],
    requirements: RelationRequirement[],
    opts: { version?: string; maxGroupHops?: number } = {},
  ) {
    for (const t of tuples) {
      if (!t.subject || !t.relation || !t.object) {
        throw new Error(`invalid RelationTuple: ${JSON.stringify(t)}`);
      }
      let byObject = this.direct.get(t.subject);
      if (!byObject) { byObject = new Map(); this.direct.set(t.subject, byObject); }
      let rels = byObject.get(t.object);
      if (!rels) { rels = new Set(); byObject.set(t.object, rels); }
      rels.add(t.relation);
      if (t.relation === 'member') {
        let groups = this.memberships.get(t.subject);
        if (!groups) { groups = new Set(); this.memberships.set(t.subject, groups); }
        groups.add(t.object);
      }
    }
    for (const r of requirements) {
      if (!r.resourceType || r.permitRelations.length === 0) {
        throw new Error(`invalid RelationRequirement for ${r.resourceType || '(empty)'}`);
      }
    }
    this.requirements = Object.freeze([...requirements]);
    this.version = opts.version ?? '1';
    this.maxGroupHops = opts.maxGroupHops ?? MAX_GROUP_HOPS;
  }

  /** Relations `subject` holds on `object`, directly or via one group hop. */
  relationsBetween(subject: string, object: string): Set<string> {
    const out = new Set<string>(this.direct.get(subject)?.get(object) ?? []);
    if (this.maxGroupHops >= 1) {
      for (const group of this.memberships.get(subject) ?? []) {
        for (const rel of this.direct.get(group)?.get(object) ?? []) out.add(rel);
      }
    }
    return out;
  }

  evaluate(input: PolicyEvaluationInput): LayerVerdict {
    const reqs = this.requirements.filter(
      (r) => r.resourceType === input.resource.type &&
        (!r.actions || r.actions.length === 0 || r.actions.includes(input.action)),
    );
    if (reqs.length === 0) {
      return { layer: this.name, effect: 'abstain', reasonCodes: [REL_REASON_CODES.NO_RELATION] };
    }
    // Relationship auth is instance-scoped: without a resource id there is no
    // object to relate to → abstain (fail-closed; do not silently permit).
    if (!input.resource.id) {
      return { layer: this.name, effect: 'abstain', reasonCodes: [REL_REASON_CODES.NO_RESOURCE_ID] };
    }
    const subject = principalRef(input.principal);
    const object = `${input.resource.type}:${input.resource.id}`;
    const held = this.relationsBetween(subject, object);

    for (const r of reqs) {
      if ((r.denyRelations ?? []).some((rel) => held.has(rel))) {
        return { layer: this.name, effect: 'deny', reasonCodes: [REL_REASON_CODES.RELATION_DENY] };
      }
    }
    for (const r of reqs) {
      const matched = r.permitRelations.find((rel) => held.has(rel));
      if (matched) {
        return { layer: this.name, effect: 'permit', reasonCodes: [REL_REASON_CODES.RELATION_GRANTED, `rel:${matched}`] };
      }
    }
    return { layer: this.name, effect: 'abstain', reasonCodes: [REL_REASON_CODES.NO_RELATION] };
  }
}

export function relationshipLayer(
  tuples: RelationTuple[],
  requirements: RelationRequirement[],
  opts: { version?: string; maxGroupHops?: number } = {},
): RelationshipLayer {
  return new RelationshipLayer(tuples, requirements, opts);
}
