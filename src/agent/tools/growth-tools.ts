// Growth Autopilot tools — schedule social content onto a calendar that the
// growth-publish cron later publishes (only after the owner approves each post).
// Nothing here publishes directly: schedule_content creates a DRAFT calendar
// row plus a pending-action approval card. Approving flips it to 'approved';
// the cron publishes at the scheduled time.
import { prisma } from '@/lib/prisma'
import { pageLabel, resolvePageId } from '@/agent/lib/meta'
import { formatDateTimeDhaka } from '@/lib/agent-api/dhaka-date'
import {
  isGrowthAutopilotOn,
  isRankTrackingOn,
  setGrowthAutopilot,
  setRankTracking,
} from '@/agent/lib/growth/settings'
import {
  createExperiment,
  listExperiments,
  startExperiment,
  concludeExperiment,
  listLearnings,
  evaluateExperiment,
  validateHypothesis,
  type ExperimentHypothesis,
  type ExperimentVerdict,
} from '@/agent/lib/marketing/experiment-registry'
import { buildCreativeMatrix, checkCreativeCompliance, assessFatigue, type CreativeFormat, type ProductFacts } from '@/agent/lib/marketing/creative-strategy'
import { getCalendarHealth } from '@/agent/lib/marketing/content-calendar'
import { validateCroBrief, formatCroBrief, type CroBrief } from '@/agent/lib/marketing/cro-brief'
import { getInstagramAccount, IG_FORMAT_SUPPORT } from '@/agent/lib/meta-instagram'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Parse a scheduled-time string into a UTC Date.
 *  Accepts full ISO (with Z or offset) as-is; treats a bare
 *  'YYYY-MM-DD HH:mm' / 'YYYY-MM-DDTHH:mm' as Asia/Dhaka local (UTC+6, no DST). */
function parseScheduledFor(raw: string): Date | null {
  const s = String(raw || '').trim()
  if (!s) return null
  // has explicit timezone → trust it
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}+06:00`
    const d = new Date(iso)
    return isNaN(d.getTime()) ? null : d
  }
  // date only → 09:00 Dhaka
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T09:00:00+06:00`)
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

const schedule_content: AgentTool = {
  name: 'schedule_content',
  description:
    'Schedule ONE Facebook or Instagram post onto the content calendar for automatic publishing at a future time. ' +
    'This creates a PENDING ACTION — the owner must approve before the post becomes eligible; the growth-publish cron then ' +
    'publishes it at the scheduled time and self-verifies. Nothing publishes without approval. ' +
    'Instagram REQUIRES an imageRef. Facebook can be text-only. ' +
    'Use this (instead of an immediate fb_post) when the owner wants posts planned across days/times — e.g. a weekly plan.',
  input_schema: {
    type: 'object' as const,
    properties: {
      platform: { type: 'string', enum: ['facebook', 'instagram'], description: 'Target platform' },
      caption: { type: 'string', description: 'The post caption / text (Bangla, on-brand, halal-compliant)' },
      scheduledFor: {
        type: 'string',
        description:
          'When to publish. ISO 8601 (with timezone) or Dhaka local "YYYY-MM-DD HH:mm" (interpreted as Asia/Dhaka).',
      },
      imageRef: {
        type: 'string',
        description:
          'Supabase storage path of the image to attach (e.g. "generated/..."). Required for Instagram; optional for Facebook.',
      },
      pageRef: {
        type: 'string',
        description: 'Page selector: "lifestyle" (default) or "trading".',
      },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['platform', 'caption', 'scheduledFor'],
  },
  handler: async (input) => {
    try {
      const platform = String(input.platform) === 'instagram' ? 'instagram' : 'facebook'
      const caption = String(input.caption ?? '').trim()
      const imageRef = input.imageRef ? String(input.imageRef).trim() : null
      const pageRef = input.pageRef ? String(input.pageRef).trim() : 'lifestyle'
      const conversationId = input.conversationId ? String(input.conversationId) : null

      if (!caption) return { success: false, error: 'caption খালি রাখা যাবে না।' }
      if (platform === 'instagram' && !imageRef) {
        return { success: false, error: 'Instagram পোস্টের জন্য একটা ছবি (imageRef) দরকার।' }
      }

      const when = parseScheduledFor(String(input.scheduledFor))
      if (!when) return { success: false, error: 'scheduledFor বুঝতে পারিনি — ISO বা "YYYY-MM-DD HH:mm" দিন।' }
      if (when.getTime() < Date.now() - 60_000) {
        return { success: false, error: 'অতীতের সময়ে পোস্ট শিডিউল করা যাবে না।' }
      }

      // validate the page resolves (throws if unknown)
      let pageId = ''
      try {
        pageId = resolvePageId(pageRef)
      } catch {
        return { success: false, error: `"${pageRef}" পেজ চিনতে পারিনি (lifestyle/trading দিন)।` }
      }

      const entry = await db.agentContentCalendar.create({
        data: {
          platform,
          pageRef,
          caption,
          imageRef,
          scheduledFor: when,
          status: 'draft',
          conversationId,
        },
      })

      const whenLabel = formatDateTimeDhaka(when)
      const summary =
        `${platform === 'instagram' ? '📸 Instagram' : '📘 Facebook'} পোস্ট শিডিউল — ${pageLabel(pageId)}\n` +
        `⏰ ${whenLabel}\n` +
        `${imageRef ? '🖼️ ছবিসহ\n' : '📝 শুধু টেক্সট\n'}` +
        `"${caption.slice(0, 180)}${caption.length > 180 ? '…' : ''}"`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId,
          type: 'schedule_content',
          payload: { calendarId: entry.id, platform, pageRef, scheduledFor: when.toISOString(), conversationId },
          summary,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id,
          calendarId: entry.id,
          platform,
          scheduledFor: when.toISOString(),
          scheduledForDhaka: whenLabel,
          message: `শিডিউল খসড়া তৈরি — approve করলে ${whenLabel}-এ নিজে থেকে পোস্ট হবে।`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const schedule_content_batch: AgentTool = {
  name: 'schedule_content_batch',
  description:
    'Schedule a WHOLE batch of posts (a campaign / weekly plan) in ONE step, creating a SINGLE approval card for all of them — ' +
    'so the owner approves the entire plan at once instead of post-by-post. Use this for "next week er jonno 5 ta post banaw" style requests. ' +
    'Each post: platform, caption, scheduledFor, optional imageRef (required for Instagram), optional pageRef. ' +
    'On approval, every post becomes eligible and the growth-publish cron publishes each at its scheduled time. ' +
    'Draft strong on-brand halal-compliant Bangla captions yourself (delegate heavy ideation to the content specialist if needed) before calling this.',
  input_schema: {
    type: 'object' as const,
    properties: {
      campaignName: { type: 'string', description: 'Short name for this campaign/plan (shown on the approval card).' },
      posts: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        description: 'The posts to schedule.',
        items: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: ['facebook', 'instagram'] },
            caption: { type: 'string' },
            scheduledFor: { type: 'string', description: 'ISO or Dhaka local "YYYY-MM-DD HH:mm".' },
            imageRef: { type: 'string', description: 'Supabase image path; required for Instagram.' },
            pageRef: { type: 'string', description: '"lifestyle" (default) or "trading".' },
          },
          required: ['platform', 'caption', 'scheduledFor'],
        },
      },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['posts'],
  },
  handler: async (input) => {
    try {
      const rawPosts = Array.isArray(input.posts) ? input.posts : []
      if (rawPosts.length === 0) return { success: false, error: 'অন্তত একটা পোস্ট দরকার।' }
      const campaignName = input.campaignName ? String(input.campaignName).trim() : 'গ্রোথ ক্যাম্পেইন'
      const conversationId = input.conversationId ? String(input.conversationId) : null

      const prepared: Array<{
        platform: string
        caption: string
        imageRef: string | null
        pageRef: string
        when: Date
      }> = []

      for (let i = 0; i < rawPosts.length; i++) {
        const p = rawPosts[i] as Record<string, unknown>
        const platform = String(p.platform) === 'instagram' ? 'instagram' : 'facebook'
        const caption = String(p.caption ?? '').trim()
        const imageRef = p.imageRef ? String(p.imageRef).trim() : null
        const pageRef = p.pageRef ? String(p.pageRef).trim() : 'lifestyle'
        if (!caption) return { success: false, error: `পোস্ট #${i + 1}: caption খালি।` }
        if (platform === 'instagram' && !imageRef) {
          return { success: false, error: `পোস্ট #${i + 1}: Instagram-এর জন্য ছবি (imageRef) লাগবে।` }
        }
        const when = parseScheduledFor(String(p.scheduledFor))
        if (!when) return { success: false, error: `পোস্ট #${i + 1}: scheduledFor বুঝিনি।` }
        if (when.getTime() < Date.now() - 60_000) {
          return { success: false, error: `পোস্ট #${i + 1}: অতীতের সময় দেওয়া যাবে না।` }
        }
        try {
          resolvePageId(pageRef)
        } catch {
          return { success: false, error: `পোস্ট #${i + 1}: "${pageRef}" পেজ চিনিনি।` }
        }
        prepared.push({ platform, caption, imageRef, pageRef, when })
      }

      const created = await db.$transaction(
        prepared.map((p) =>
          db.agentContentCalendar.create({
            data: {
              platform: p.platform,
              pageRef: p.pageRef,
              caption: p.caption,
              imageRef: p.imageRef,
              scheduledFor: p.when,
              status: 'draft',
              conversationId,
            },
          }),
        ),
      )
      const calendarIds = created.map((c: { id: string }) => c.id)

      const lines = prepared
        .slice()
        .sort((a, b) => a.when.getTime() - b.when.getTime())
        .map(
          (p) =>
            `• ${p.platform === 'instagram' ? '📸' : '📘'} ${formatDateTimeDhaka(p.when)} — ${p.caption.slice(0, 60)}${p.caption.length > 60 ? '…' : ''}`,
        )
      const summary =
        `📅 ক্যাম্পেইন: ${campaignName} — ${prepared.length}টি পোস্ট\n` +
        `${lines.join('\n')}\n\nএকবার approve করলেই সবগুলো নির্ধারিত সময়ে নিজে নিজে পোস্ট হবে।`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId,
          type: 'schedule_content_batch',
          payload: { calendarIds, campaignName, count: prepared.length, conversationId },
          summary,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id,
          campaignName,
          count: prepared.length,
          calendarIds,
          message: `${prepared.length}টি পোস্টের একটাই approval card তৈরি — approve করলে পুরো প্ল্যান চালু।`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const list_content_calendar: AgentTool = {
  name: 'list_content_calendar',
  description:
    'List planned/scheduled social posts from the content calendar. ' +
    'Optionally filter by status (draft | approved | published | failed | canceled). ' +
    'Shows platform, time, status, and a caption preview so the owner can review the plan.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['draft', 'approved', 'published', 'failed', 'canceled', 'upcoming'],
        description: '"upcoming" = draft+approved not yet published. Omit for all recent.',
      },
      limit: { type: 'number', description: 'Max rows (default 20, max 50).' },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const status = input.status ? String(input.status) : null
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50)
      const where: Record<string, unknown> = {}
      if (status === 'upcoming') where.status = { in: ['draft', 'approved'] }
      else if (status) where.status = status

      const rows = await db.agentContentCalendar.findMany({
        where,
        orderBy: { scheduledFor: 'asc' },
        take: limit,
      })

      const items = rows.map(
        (r: {
          id: string
          platform: string
          pageRef: string
          caption: string
          imageRef: string | null
          scheduledFor: Date
          status: string
          permalinkUrl: string | null
          error: string | null
        }) => ({
          id: r.id,
          platform: r.platform,
          page: r.pageRef,
          when: formatDateTimeDhaka(r.scheduledFor),
          status: r.status,
          hasImage: Boolean(r.imageRef),
          caption: r.caption.slice(0, 120),
          permalink: r.permalinkUrl,
          error: r.error,
        }),
      )

      return { success: true, data: { count: items.length, items } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const cancel_scheduled_content: AgentTool = {
  name: 'cancel_scheduled_content',
  description:
    'Cancel a not-yet-published scheduled post by its calendar id. Only draft/approved entries can be canceled; ' +
    'already-published posts cannot be un-published from here.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Calendar entry id from list_content_calendar.' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    try {
      const id = String(input.id ?? '').trim()
      if (!id) return { success: false, error: 'id দরকার।' }
      const row = await db.agentContentCalendar.findUnique({ where: { id } })
      if (!row) return { success: false, error: 'এই id-র কোনো শিডিউল পাইনি।' }
      if (row.status === 'published') {
        return { success: false, error: 'এটা ইতিমধ্যেই পোস্ট হয়ে গেছে — এখান থেকে বাতিল করা যাবে না।' }
      }
      if (row.status === 'canceled') return { success: true, data: { id, message: 'আগেই বাতিল করা ছিল।' } }
      await db.agentContentCalendar.update({ where: { id }, data: { status: 'canceled' } })
      // also void any still-pending approval card for this entry
      await db.agentPendingAction.updateMany({
        where: { type: 'schedule_content', status: 'pending', payload: { path: ['calendarId'], equals: id } },
        data: { status: 'canceled', resolvedAt: new Date() },
      })
      return { success: true, data: { id, message: 'শিডিউল বাতিল করা হলো।' } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const configure_growth_autopilot: AgentTool = {
  name: 'configure_growth_autopilot',
  description:
    'View or change the Growth Autopilot switches (owner-only control, takes effect immediately, no redeploy). ' +
    'Call with NO arguments to just report current status. ' +
    '`autopilot` on/off is the master for the scheduled-publish + weekly-digest crons (default ON; turning it OFF ' +
    'pauses all autonomous publishing and the weekly report — already-scheduled approved posts simply wait). ' +
    '`rankTracking` on/off controls the weekly Google-rank SERP pull, which spends Oxylabs credits (default OFF). ' +
    'This only flips the switches — it never publishes or spends by itself.',
  input_schema: {
    type: 'object' as const,
    properties: {
      autopilot: { type: 'string', enum: ['on', 'off'], description: 'Master switch for publish + digest crons.' },
      rankTracking: { type: 'string', enum: ['on', 'off'], description: 'Weekly SERP rank pull (spends credits).' },
    },
  },
  handler: async (input) => {
    try {
      const changed: string[] = []
      if (input.autopilot === 'on' || input.autopilot === 'off') {
        await setGrowthAutopilot(input.autopilot === 'on')
        changed.push(`অটোপাইলট ${input.autopilot === 'on' ? 'চালু' : 'বন্ধ'}`)
      }
      if (input.rankTracking === 'on' || input.rankTracking === 'off') {
        await setRankTracking(input.rankTracking === 'on')
        changed.push(`র‍্যাঙ্ক ট্র্যাকিং ${input.rankTracking === 'on' ? 'চালু' : 'বন্ধ'}`)
      }
      const [autopilot, rankTracking] = await Promise.all([isGrowthAutopilotOn(), isRankTrackingOn()])
      const status = `অটোপাইলট: ${autopilot ? 'চালু ✅' : 'বন্ধ ⛔'} | র‍্যাঙ্ক ট্র্যাকিং: ${rankTracking ? 'চালু ✅' : 'বন্ধ ⛔'}`
      return {
        success: true,
        data: {
          autopilot,
          rankTracking,
          message: changed.length ? `${changed.join(', ')}। এখন — ${status}` : status,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const growth_experiment: AgentTool = {
  name: 'growth_experiment',
  description:
    'Experiment registry — marketing as testable hypotheses. action=create (full hypothesis: audience, awareness ' +
    'stage, pain/desire, offer, angle, hook, proof, format, destination, metric+guardrail, minSample, windowDays, ' +
    'winner/guardrail rules), list, start, evaluate (pre-agreed rules; refuses winner calls below the sample floor), ' +
    'conclude (learning sentence MANDATORY), learnings (verified outcomes that must shape future decisions).',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', description: 'create | list | start | evaluate | conclude | learnings' },
      name: { type: 'string', description: 'create: experiment name' },
      hypothesis: { type: 'object', description: 'create: ExperimentHypothesis JSON' },
      briefVersion: { type: 'number', description: 'create: growth-brief version this serves' },
      id: { type: 'string', description: 'start/evaluate/conclude: experiment id' },
      observed: { type: 'object', description: 'evaluate/conclude: {sample, metricValue, guardrailValue}' },
      verdict: { type: 'string', description: 'conclude: won|lost|inconclusive|stopped|guardrail_breach' },
      learning: { type: 'string', description: 'conclude: what this experiment taught us (required)' },
      status: { type: 'string', description: 'list: filter by status' },
    },
    required: ['action'],
  },
  handler: async (input) => {
    try {
      const action = String(input.action)
      if (action === 'create') {
        const hypothesis = input.hypothesis as unknown as ExperimentHypothesis
        const v = validateHypothesis(hypothesis)
        if (!v.ok) return { success: false, error: `hypothesis incomplete — missing: ${v.missing.join(', ')}` }
        const row = await createExperiment({
          name: String(input.name ?? 'unnamed experiment'),
          hypothesis,
          briefVersion: input.briefVersion == null ? null : Number(input.briefVersion),
        })
        return { success: true, data: { id: row.id, status: row.status } }
      }
      if (action === 'list') {
        const rows = await listExperiments({ status: input.status ? String(input.status) : undefined })
        return { success: true, data: { experiments: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, briefVersion: r.briefVersion })) } }
      }
      if (action === 'start') {
        const row = await startExperiment(String(input.id))
        return { success: true, data: { id: row.id, status: row.status, startAt: row.startAt } }
      }
      if (action === 'evaluate') {
        const rows = await listExperiments({})
        const row = rows.find((r) => r.id === String(input.id))
        if (!row) return { success: false, error: `experiment ${input.id} not found` }
        const observed = input.observed as { sample: number; metricValue: number; guardrailValue: number }
        if (!observed || !Number.isFinite(observed.sample)) return { success: false, error: 'observed {sample, metricValue, guardrailValue} required' }
        return { success: true, data: evaluateExperiment(row.hypothesis, observed) }
      }
      if (action === 'conclude') {
        const row = await concludeExperiment({
          id: String(input.id),
          verdict: String(input.verdict ?? 'stopped') as ExperimentVerdict | 'stopped',
          observed: input.observed as { sample: number; metricValue: number; guardrailValue: number } | undefined,
          learning: String(input.learning ?? ''),
        })
        return { success: true, data: { id: row.id, status: row.status, learning: row.learning } }
      }
      if (action === 'learnings') {
        return { success: true, data: { learnings: await listLearnings() } }
      }
      return { success: false, error: `unknown action "${action}"` }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const creative_matrix: AgentTool = {
  name: 'creative_matrix',
  description:
    'Build a gated creative matrix for an experiment: one variant per format (static|carousel|reel|story|messenger|' +
    'landing_page|email|sms|organic_post), each tied to the experiment and pre-checked against the hard gates ' +
    '(haram content, fake urgency/testimonials, unsupported claims; numeric claims must exist in productFacts). ' +
    'Variants with compliance.ok=false must be fixed BEFORE any preview/approval. Also: action=check_copy for a single ' +
    'text, action=fatigue for {ageDays, frequency, ctrTrendRatio}.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', description: 'build | check_copy | fatigue (default build)' },
      experimentId: { type: 'string', description: 'build: experiment the variants belong to' },
      hypothesis: { type: 'object', description: 'build: {angle, hook, offer, proof, destination}' },
      formats: { type: 'array', items: { type: 'string' }, description: 'build: formats to generate' },
      productFacts: { type: 'object', description: '{name, priceBdt, facts[]} — grounds numeric claims' },
      copy: { type: 'string', description: 'check_copy: text to gate' },
      fatigue: { type: 'object', description: 'fatigue: {ageDays, frequency, ctrTrendRatio}' },
    },
  },
  handler: async (input) => {
    try {
      const action = String(input.action ?? 'build')
      if (action === 'check_copy') {
        return { success: true, data: checkCreativeCompliance(String(input.copy ?? ''), (input.productFacts as ProductFacts) ?? null) }
      }
      if (action === 'fatigue') {
        const f = input.fatigue as { ageDays: number; frequency: number; ctrTrendRatio: number }
        if (!f) return { success: false, error: 'fatigue {ageDays, frequency, ctrTrendRatio} required' }
        return { success: true, data: assessFatigue(f) }
      }
      if (!input.experimentId) return { success: false, error: 'experimentId required — every asset belongs to an experiment' }
      const variants = buildCreativeMatrix({
        experimentId: String(input.experimentId),
        hypothesis: input.hypothesis as { angle: string; hook: string; offer: string; proof: string; destination: string },
        formats: (input.formats as CreativeFormat[]) ?? ['static', 'organic_post'],
        productFacts: (input.productFacts as ProductFacts) ?? null,
      })
      return {
        success: true,
        data: {
          variants,
          blocked: variants.filter((v) => !v.compliance.ok).length,
          note: 'compliance.ok=false variants must be fixed before preview — they never ship.',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const content_calendar_health: AgentTool = {
  name: 'content_calendar_health',
  description:
    'Calendar operations health (±14 days): stale drafts past their slot, approved posts past due (stuck cron), ' +
    'failed posts with errors, same-page timing conflicts that cannibalize reach — plus recovery advice. Read-only.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      return { success: true, data: await getCalendarHealth() }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const cro_brief_draft: AgentTool = {
  name: 'cro_brief_draft',
  description:
    'Validate + format a CRO brief (landing/checkout improvement): page, problem, EVIDENCE (analytics numbers ' +
    'required), hypothesis, exact change, expected impact RANGE, a11y/mobile/perf checklist, rollback plan. ' +
    'Output is a brief for owner review — never a live-site edit; implementation goes through branch+preview+merge.',
  input_schema: {
    type: 'object' as const,
    properties: {
      brief: { type: 'object', description: 'CroBrief JSON' },
    },
    required: ['brief'],
  },
  handler: async (input) => {
    try {
      const brief = input.brief as unknown as CroBrief
      const v = validateCroBrief(brief)
      if (!v.ok) return { success: false, error: `CRO brief invalid: ${v.errors.join('; ')}` }
      return { success: true, data: { formatted: formatCroBrief(brief), brief } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const social_ops_health: AgentTool = {
  name: 'social_ops_health',
  description:
    'Social publishing asset health (read-only): Instagram account linkage per page + the honest IG format-support ' +
    'matrix (single_image only today — reel/carousel/story explicitly unsupported until the VPS worker phase). ' +
    'Use before promising any IG format to the owner.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const [lifestyle, onlineshop] = await Promise.all([
        getInstagramAccount(resolvePageId('lifestyle')).catch((e) => ({ success: false, error: String(e) })),
        getInstagramAccount(resolvePageId('onlineshop')).catch((e) => ({ success: false, error: String(e) })),
      ])
      return {
        success: true,
        data: {
          instagram: {
            lifestyle,
            onlineshop,
          },
          formatSupport: IG_FORMAT_SUPPORT,
          note: 'Unsupported মানে unsupported — owner-কে reel/carousel promise করবেন না যতক্ষণ না worker path আসে।',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const GROWTH_TOOLS: AgentTool[] = [
  schedule_content,
  schedule_content_batch,
  list_content_calendar,
  cancel_scheduled_content,
  configure_growth_autopilot,
  growth_experiment,
  creative_matrix,
  content_calendar_health,
  cro_brief_draft,
  social_ops_health,
]

export const GROWTH_ROLE_PROMPT = `
## গ্রোথ অটোপাইলট — কনটেন্ট ক্যালেন্ডার
- মালিক যখন সময় ধরে একাধিক পোস্ট চান (যেমন "আগামী সপ্তাহের জন্য ৫টা FB পোস্ট বানাও"), তখন **schedule_content_batch** ব্যবহার করুন — সব ক্যাপশন নিজে লিখে (ভারী আইডিয়া দরকার হলে content specialist-কে delegate করে), সময় বেছে, একবারে সব শিডিউল করুন। এতে মালিক **একটাই approval card**-এ পুরো প্ল্যান অনুমোদন করেন।
- একটা মাত্র পোস্ট শিডিউল করতে **schedule_content**; এখনই পোস্ট করতে পুরোনো fb_post/instagram_post।
- ক্যাপশন সবসময় বাংলা, on-brand, হালাল-সম্মত। Instagram-এ ছবি বাধ্যতামূলক — ছবি লাগলে আগে generate_image (approval) করে তার path imageRef-এ দিন।
- **কিছুই নিজে থেকে পাবলিশ হয় না** — approve করলে তবেই নির্ধারিত সময়ে cron পোস্ট করে। প্ল্যান দেখতে list_content_calendar, বাতিল করতে cancel_scheduled_content।
- সময় দিন Dhaka লোকাল "YYYY-MM-DD HH:mm" বা ISO ফরম্যাটে; অতীতের সময় দেবেন না।
- মালিক অটোপাইলট চালু/বন্ধ বা সাপ্তাহিক র‍্যাঙ্ক ট্র্যাকিং চালু/বন্ধ চাইলে **configure_growth_autopilot** ব্যবহার করুন (কোনো argument ছাড়া কল করলে বর্তমান অবস্থা দেখায়)। অটোপাইলট বন্ধ থাকলে শিডিউলড পোস্ট আর সাপ্তাহিক রিপোর্ট থেমে থাকে।
- **Experiment discipline (Phase 44):** বড় কনটেন্ট/অ্যাড push মানে একটা hypothesis — growth_experiment (create→start→evaluate→conclude+learning)। Asset বানাতে creative_matrix (হারাম/ভুয়া-urgency/ভুয়া-testimonial/ungrounded-claim gate built-in; compliance.ok=false হলে আগে ঠিক করুন)। ক্যালেন্ডার সমস্যা দেখতে content_calendar_health; landing-page উন্নতি প্রস্তাবে cro_brief_draft (evidence + rollback ছাড়া invalid)।
`
