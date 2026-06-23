/**
 * Specialist sub-agent roles for the head→sub-agent orchestrator (Part D, Phase 2).
 *
 * The head agent (Claude Sonnet) stays in charge of the conversation. For discrete
 * sub-tasks of a larger job it can spawn a focused specialist sub-agent — same model,
 * but a narrowed tool set + a role-specific brief — so each piece of work runs with
 * the right tools and a clear mandate. The owner sees this happen live as delegation
 * cards (Cursor-style), and the CCTV "Agents" tab attributes the cost per role.
 *
 * Pure data module — imports a TYPE only, so it is safe to import from anywhere
 * (registry, core, tools) without circular-dependency hazards.
 */
import type { ToolGroupName } from '@/agent/tools/tool-groups'

export type SpecialistRole = 'researcher' | 'analyst' | 'marketer' | 'content' | 'ops' | 'cs'

export interface SpecialistRoleDef {
  /** Bangla label shown to the owner on the delegation card + CCTV view. */
  label: string
  /** English label for logs/cost attribution. */
  labelEn: string
  /** A short emoji used on the delegation card. */
  icon: string
  /** Tool groups this specialist may use (delegate tool itself is always excluded). */
  toolGroups: ToolGroupName[]
  /** Role brief prepended to the sub-agent's system prompt. */
  instruction: string
  /**
   * Preferred worker model (registry id) for this non-critical role — e.g. a cheap
   * OpenRouter model. Consumed by resolveSubagentModel (tier-router): on NON-critical
   * tiers this overrides the tier default; the critical role (analyst — finance/data
   * analysis) ignores it and stays on Claude via assertCriticalTierUsesClaude. Requires OPENROUTER_API_KEY for
   * OpenRouter models — otherwise the worker falls back (Gemini → Claude).
   */
  preferredModelId?: string
}

export const SPECIALIST_ROLES: Record<SpecialistRole, SpecialistRoleDef> = {
  researcher: {
    label: 'গবেষক',
    labelEn: 'Researcher',
    icon: '🔎',
    toolGroups: ['base', 'growth'],
    instruction:
      'You are a market & competitor research specialist. Gather real signals using the available research/competitor/SEO tools, then return a concise, sourced Bangla summary of findings and one clear recommendation.',
    // Owner rule: Qwen orchestrates as head, DeepSeek does the sub-agent work
    // (cheapest tool-capable worker). Non-critical → safe to run on DeepSeek.
    preferredModelId: 'or-deepseek-v4-flash',
  },
  analyst: {
    label: 'বিশ্লেষক',
    labelEn: 'Analyst',
    icon: '📊',
    toolGroups: ['base', 'erp', 'finance'],
    instruction:
      'You are a business data analyst. Pull real numbers (orders, stock, sales, ledger) with the ERP/finance tools, never guess. Return a concise Bangla summary with the key figures and what they imply.',
  },
  marketer: {
    label: 'মার্কেটার',
    labelEn: 'Marketer',
    icon: '📣',
    // base + growth (ads/marketing/SEO) + content (FB posts/creatives) + staff so
    // it can PREPARE office-staff tasks (e.g. a product-shoot for a campaign).
    // Posting, ad-spend and staff dispatch all stay behind their own owner-approval
    // gates — the marketer drafts/proposes, the owner confirms the spend/dispatch.
    toolGroups: ['base', 'growth', 'content', 'staff'],
    instruction:
      'You are ALMA Lifestyle\'s digital marketing lead (Facebook/ads focus) — and you OWN marketing end to end, ' +
      'not just planning. Use the marketing/ads/SEO tools to assess performance and plan; create and (where a tool ' +
      'allows) publish on-brand, halal-compliant Facebook posts; set up / run Facebook ad campaigns; and when a ' +
      'campaign needs office-staff work (e.g. a product photoshoot or packaging push), PREPARE that as a staff task ' +
      'with the staff tools. Anything that spends money, publishes publicly, or dispatches a staff task will surface ' +
      'its own owner-approval card — so propose freely, the owner confirms the final spend/post/dispatch. Return a ' +
      'concise Bangla summary of what you did and what is awaiting the owner\'s approval.',
    // Owner rule: sub-agent work goes to DeepSeek (cheapest worker), Qwen stays the
    // orchestrating head. The marketer sub-agent is only invoked when a non-marketing
    // head delegates marketing, so DeepSeek keeps that hop cheap.
    preferredModelId: 'or-deepseek-v4-flash',
  },
  content: {
    label: 'কনটেন্ট',
    labelEn: 'Content',
    icon: '✍️',
    toolGroups: ['base', 'content'],
    instruction:
      'You are a brand content & creative specialist. Draft on-brand, halal-compliant copy/ideas using the content tools. Return a concise Bangla draft or set of options.',
    // Owner rule: DeepSeek does the sub-agent content drafting (cheap), not Qwen.
    preferredModelId: 'or-deepseek-v4-flash',
  },
  ops: {
    label: 'অপারেশনস',
    labelEn: 'Operations',
    icon: '🗂️',
    toolGroups: ['base', 'staff'],
    instruction:
      'You are an operations specialist for staff/task coordination. Use the staff tools to check presence, tasks and dispatch state, then return a concise Bangla status with any issues that need the owner.',
    // Owner decision: staff dispatch/coordination is a small job — run it on cheap DeepSeek,
    // not Claude. `ops` is no longer a critical role (finance/`analyst` stays on Claude).
    preferredModelId: 'or-deepseek-v4-flash',
  },
  cs: {
    label: 'কাস্টমার সার্ভিস',
    labelEn: 'Customer Service',
    icon: '💬',
    toolGroups: ['base', 'cs'],
    instruction:
      'You are a customer-service specialist for ALMA Lifestyle. Use the CS tools to read the customer, order and product context, then return a concise, empathetic Bangla/Banglish reply or status. Never invent stock or price — verify with tools first.',
    // Owner decision: CS is customer-facing, so it runs on Qwen (stronger Bangla
    // quality) rather than DeepSeek — the cost trade-off is accepted for replies the
    // customer actually reads. Staff/`ops` stays on cheap DeepSeek; finance/`analyst`
    // stays on Claude. NOTE: not yet delegatable — the head can't route to `cs` until
    // the orchestrator + tier-router are wired in the later routing step.
    preferredModelId: 'or-qwen3-max',
  },
}

export const SPECIALIST_ROLE_KEYS = Object.keys(SPECIALIST_ROLES) as SpecialistRole[]

export function specialistLabel(role: string): string {
  return (SPECIALIST_ROLES as Record<string, SpecialistRoleDef>)[role]?.label ?? role
}

/** Bangla + English — for CCTV / owner visibility. */
export function specialistDisplayName(role: string): string {
  const d = (SPECIALIST_ROLES as Record<string, SpecialistRoleDef>)[role]
  if (!d) return role
  return `${d.label} · ${d.labelEn}`
}

export function specialistIcon(role: string): string {
  return (SPECIALIST_ROLES as Record<string, SpecialistRoleDef>)[role]?.icon ?? '🤝'
}
