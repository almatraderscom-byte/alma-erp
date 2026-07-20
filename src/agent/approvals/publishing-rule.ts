/**
 * External publishing approval rules (G12 / SPEC-114).
 *
 * Anything the agent makes PUBLIC (a Facebook post, a customer message, an ad, a
 * comment) carries brand + reputational risk, so it is approval-gated by default.
 * The rule reads the action's `audience`: public/external ⇒ require_approval,
 * internal/draft ⇒ autonomous_ok, unknown ⇒ require_approval (fail-closed). A
 * non-publishing action abstains.
 *
 * Deterministic, pure (INV-01). Fail-closed (INV-05): if we cannot tell who will
 * see it, ASK before it goes out.
 */
import { z } from 'zod';
import type { ApprovalRule, ApprovalVerdict, AutonomyInput } from '../autonomy/states';

export const PUBLISHING_REASON_CODES = {
  EXTERNAL_AUDIENCE: 'PUBLISHING_EXTERNAL_AUDIENCE',
  AUDIENCE_UNKNOWN: 'PUBLISHING_AUDIENCE_UNKNOWN',
  INTERNAL_OK: 'PUBLISHING_INTERNAL_OK',
} as const;

export interface PublishingRuleConfig {
  publishingResourceTypes?: string[];
  publishingActionPrefixes?: string[];
  /** Audience values considered external/public (require approval). */
  externalAudiences?: string[];
  /** Audience values considered safe/internal (may be autonomous). */
  internalAudiences?: string[];
}

const DEFAULT_TYPES = ['post', 'message', 'comment', 'ad', 'story', 'reel'];
const DEFAULT_PREFIXES = ['facebook.', 'instagram.', 'whatsapp.', 'publish.', 'post.', 'message.', 'comment.', 'ad.'];
const DEFAULT_EXTERNAL = ['public', 'external', 'customer', 'audience'];
const DEFAULT_INTERNAL = ['internal', 'draft', 'preview', 'self'];

const configSchema = z.object({
  publishingResourceTypes: z.array(z.string().min(1)).optional(),
  publishingActionPrefixes: z.array(z.string().min(1)).optional(),
  externalAudiences: z.array(z.string().min(1)).optional(),
  internalAudiences: z.array(z.string().min(1)).optional(),
});

export class PublishingApprovalRule implements ApprovalRule {
  readonly name = 'publishing';
  private readonly types: string[];
  private readonly prefixes: string[];
  private readonly external: string[];
  private readonly internal: string[];

  constructor(config: PublishingRuleConfig = {}) {
    if (!configSchema.safeParse(config).success) throw new Error('invalid PublishingRuleConfig');
    this.types = config.publishingResourceTypes ?? DEFAULT_TYPES;
    this.prefixes = config.publishingActionPrefixes ?? DEFAULT_PREFIXES;
    this.external = config.externalAudiences ?? DEFAULT_EXTERNAL;
    this.internal = config.internalAudiences ?? DEFAULT_INTERNAL;
  }

  private isPublishing(action: string, resourceType: string): boolean {
    return this.types.includes(resourceType) || this.prefixes.some((p) => action.startsWith(p));
  }

  evaluate(input: AutonomyInput): ApprovalVerdict {
    const { action, resourceType, attributes } = input.action;
    if (!this.isPublishing(action, resourceType)) {
      return { rule: this.name, effect: 'abstain', reasonCodes: [] };
    }
    const audience = attributes?.audience;
    if (typeof audience === 'string' && this.internal.includes(audience)) {
      return { rule: this.name, effect: 'autonomous_ok', reasonCodes: [PUBLISHING_REASON_CODES.INTERNAL_OK] };
    }
    if (typeof audience === 'string' && this.external.includes(audience)) {
      return { rule: this.name, effect: 'require_approval', reasonCodes: [PUBLISHING_REASON_CODES.EXTERNAL_AUDIENCE] };
    }
    // Unknown / unspecified audience for a publishing action → fail closed.
    return { rule: this.name, effect: 'require_approval', reasonCodes: [PUBLISHING_REASON_CODES.AUDIENCE_UNKNOWN] };
  }
}

export function publishingApprovalRule(config: PublishingRuleConfig = {}): PublishingApprovalRule {
  return new PublishingApprovalRule(config);
}
