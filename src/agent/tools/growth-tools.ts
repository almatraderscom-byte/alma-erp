// Growth Autopilot tools — schedule social content onto a calendar that the
// growth-publish cron later publishes (only after the owner approves each post).
// Nothing here publishes directly: schedule_content creates a DRAFT calendar
// row plus a pending-action approval card. Approving flips it to 'approved';
// the cron publishes at the scheduled time.
import { prisma } from '@/lib/prisma'
import { pageLabel, resolvePageId } from '@/agent/lib/meta'
import { formatDateTimeDhaka } from '@/lib/agent-api/dhaka-date'
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
      conversationId: { type: 'string' },
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

export const GROWTH_TOOLS: AgentTool[] = [schedule_content, list_content_calendar, cancel_scheduled_content]
