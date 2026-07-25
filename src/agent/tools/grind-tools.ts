/**
 * Grind-engine tools — the head's ONLY entry points into a fix campaign.
 *
 * Deliberately two, and deliberately narrow:
 *   start_fix_campaign — names a SOURCE ("everything the audit found"), never a
 *                        list of steps. The step graph is derived from the
 *                        measured findings so nothing can be quietly dropped.
 *   record_root_cause  — writes the diagnosis a fix step is gated on. Without it
 *                        the fix is never dispatched.
 *
 * Note there is no "mark it fixed" tool, and there never will be: only the
 * deterministic verifier writes `fixed` (invariant I1).
 */
import type { AgentTool } from './registry'
import { startFixCampaign, normalizeTarget } from '@/agent/lib/grind/campaign'
import {
  listFindings,
  recordRootCause,
  tallySet,
  type FindingSource,
} from '@/agent/lib/grind/finding-set'
import { grindHeadline } from '@/agent/lib/grind/completion'
import { MIN_ROOT_CAUSE_CHARS } from '@/agent/lib/grind/diagnosis-gate'

const start_fix_campaign: AgentTool = {
  name: 'start_fix_campaign',
  description:
    'Start a durable "fix everything" campaign over an ALREADY MEASURED set of problems ' +
    '(a finished SEO audit, a website health scan, the product-SEO sweep). Use this when Boss says ' +
    '"fix all the issues you found" / "সব ঠিক করো". It loads the findings, groups them into fix families, ' +
    'and builds the whole diagnose → fix → verify plan itself — you do NOT author the steps. ' +
    'The agent then grinds through it on its own and cannot report done until every finding has been ' +
    're-measured. Returns the campaign + plan ids and the step count.',
  input_schema: {
    type: 'object' as const,
    properties: {
      source: {
        type: 'string',
        enum: ['seo_audit', 'health_scan', 'product_seo'],
        description: 'Which measurement to grind through. Default seo_audit.',
      },
      target: {
        type: 'string',
        description: 'What was measured — e.g. "almatraders.com". Required for seo_audit.',
      },
      batch_size: {
        type: 'number',
        description: 'Findings per fix step (default 10). Smaller = more careful, more turns.',
      },
    },
    required: ['target'],
  },
  handler: async (input) => {
    const target = String(input.target ?? '').trim()
    if (!target) return { success: false, error: 'target is required (e.g. almatraders.com)' }
    const source = (String(input.source ?? 'seo_audit') as FindingSource)
    const batchSize = typeof input.batch_size === 'number' ? Math.max(1, Math.min(50, input.batch_size)) : undefined
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId : null
    const businessId = typeof input.businessId === 'string' ? input.businessId : undefined

    try {
      const res = await startFixCampaign({ source, target, conversationId, businessId, batchSize })
      return {
        success: true,
        data: {
          campaign_id: res.setId,
          plan_id: res.planId,
          findings: res.findings,
          families: res.families,
          steps: res.steps,
          batches: res.batches,
          already_running: res.reused,
          message: res.reused
            ? `এই সাইটের জন্য একটা campaign আগে থেকেই চলছে (${res.findings}টা সমস্যা) — নতুন করে শুরু করিনি।`
            : `${res.findings}টা সমস্যা ${res.families}টা ধরনে ভাগ করে ${res.steps}টা ধাপের কাজ শুরু করলাম। ` +
              `প্রতিটা ব্যাচ ঠিক করার পরে আবার মেপে দেখা হবে; না মেপে "হয়ে গেছে" বলা হবে না।`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const record_root_cause: AgentTool = {
  name: 'record_root_cause',
  description:
    'Record WHY a set of findings happens, during a diagnose step of a fix campaign. ' +
    'A fix step is not allowed to run until every finding in its batch has one: at least ' +
    `${MIN_ROOT_CAUSE_CHARS} characters of real explanation AND a concrete reference (file:line or a URL). ` +
    'If you do not know the cause, say so and keep digging — do NOT write a guess; a wrong cause ' +
    'produces a fix that breaks something else.',
  input_schema: {
    type: 'object' as const,
    properties: {
      campaign_id: { type: 'string', description: 'The campaign id from start_fix_campaign' },
      fingerprints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Findings this cause explains, as "scope|code" (e.g. "https://site/x|missing_h1")',
      },
      root_cause: {
        type: 'string',
        description: 'The actual cause, in plain language — what produces this, not what the symptom is',
      },
      ref: {
        type: 'string',
        description: 'Concrete evidence: file:line in the repo, or the URL where it is visible',
      },
    },
    required: ['campaign_id', 'fingerprints', 'root_cause', 'ref'],
  },
  handler: async (input) => {
    const setId = String(input.campaign_id ?? '').trim()
    const rootCause = String(input.root_cause ?? '').trim()
    const ref = String(input.ref ?? '').trim()
    const fingerprints = Array.isArray(input.fingerprints) ? input.fingerprints.map((f) => String(f)) : []

    if (!setId) return { success: false, error: 'campaign_id is required' }
    if (fingerprints.length === 0) return { success: false, error: 'fingerprints is required' }
    if (rootCause.length < MIN_ROOT_CAUSE_CHARS) {
      return {
        success: false,
        error: `root_cause is too short (${rootCause.length}) — at least ${MIN_ROOT_CAUSE_CHARS} characters of real explanation.`,
      }
    }
    if (!ref) return { success: false, error: 'ref is required — file:line or a URL' }

    const updated = await recordRootCause({ setId, fingerprints, rootCause, ref })
    return {
      success: true,
      data: {
        updated,
        message: `${updated}টা সমস্যার কারণ লিখে রাখলাম।`,
      },
    }
  },
}

const get_fix_campaign: AgentTool = {
  name: 'get_fix_campaign',
  description:
    'Progress of a running fix campaign: how many findings are genuinely verified fixed, how many are ' +
    'still open, how many are only CLAIMED fixed, and whether any new problem was introduced. ' +
    'Read this before telling Boss anything about progress — the numbers here are measured, not claimed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      campaign_id: { type: 'string', description: 'The campaign id from start_fix_campaign' },
      family: { type: 'string', description: 'Optional: list the findings of one family' },
    },
    required: ['campaign_id'],
  },
  handler: async (input) => {
    const setId = String(input.campaign_id ?? '').trim()
    if (!setId) return { success: false, error: 'campaign_id is required' }

    const tally = await tallySet(setId)
    const family = typeof input.family === 'string' ? input.family.trim() : ''
    const findings = family
      ? (await listFindings(setId, { family })).map((f) => ({
          fingerprint: f.fingerprint,
          status: f.status,
          severity: f.severity,
          scope: f.scope,
          root_cause: f.rootCause,
        }))
      : undefined

    return {
      success: true,
      data: {
        headline: grindHeadline(tally),
        total: tally.total,
        fixed: tally.fixed,
        open: tally.open,
        in_progress: tally.inProgress,
        claimed_not_verified: tally.claimedOnly,
        regressed: tally.regressed,
        needs_rediagnosis: tally.needsRediagnosis,
        introduced_by_us: tally.introduced,
        by_family: tally.byFamily,
        findings,
      },
    }
  },
}

export { normalizeTarget }
export const GRIND_TOOLS: AgentTool[] = [start_fix_campaign, record_root_cause, get_fix_campaign]
