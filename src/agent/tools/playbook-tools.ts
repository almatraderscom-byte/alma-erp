import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const list_playbook: AgentTool = {
  name: 'list_playbook',
  description:
    'List agent playbook heuristics (learned rules) for owner review. ' +
    'Only `active` heuristics are injected into the system prompt — `proposed` await your approval.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['proposed', 'active', 'rejected', 'retired', 'all'],
        description: 'Default proposed — pending owner review',
      },
      businessId: { type: 'string', enum: ['ALMA_LIFESTYLE', 'ALMA_TRADING'] },
    },
  },
  handler: async (input) => {
    const status = String(input.status ?? 'proposed')
    const businessId = input.businessId === 'ALMA_TRADING' ? 'ALMA_TRADING' : 'ALMA_LIFESTYLE'
    try {
      const where = status === 'all' ? { businessId } : { businessId, status }
      const rows = await db.agentPlaybook.findMany({
        where,
        orderBy: [{ status: 'asc' }, { confidence: 'desc' }, { createdAt: 'desc' }],
        take: 30,
      })
      return {
        success: true,
        data: {
          count: rows.length,
          items: rows.map(
            (r: {
              id: string
              businessId: string
              domain: string
              heuristic: string
              evidence: string
              confidence: number
              status: string
              timesApplied: number
              createdAt: Date
              reviewedAt: Date | null
            }) => ({
              id: r.id,
              businessId: r.businessId,
              domain: r.domain,
              heuristic: r.heuristic,
              evidence: r.evidence,
              confidence: r.confidence,
              status: r.status,
              timesApplied: r.timesApplied,
              createdAt: r.createdAt.toISOString(),
              reviewedAt: r.reviewedAt?.toISOString() ?? null,
            }),
          ),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const approve_playbook: AgentTool = {
  name: 'approve_playbook',
  description:
    'Owner approves a proposed playbook heuristic — it becomes active and is injected into future agent turns. ' +
    'Use when owner says yes/approve/রাখো for a weekly reflection lesson.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Playbook row id from list_playbook' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const id = String(input.id ?? '').trim()
    if (!id) return { success: false, error: 'id is required' }
    try {
      const row = await db.agentPlaybook.findUnique({ where: { id } })
      if (!row) return { success: false, error: 'playbook entry not found' }
      if (row.status === 'active') {
        return { success: true, data: { id, status: 'active', message: 'ইতিমধ্যে active।' } }
      }
      if (row.status !== 'proposed') {
        return { success: false, error: `Cannot approve status=${row.status}` }
      }
      const updated = await db.agentPlaybook.update({
        where: { id },
        data: { status: 'active', reviewedAt: new Date() },
      })
      return {
        success: true,
        data: {
          id: updated.id,
          domain: updated.domain,
          heuristic: updated.heuristic,
          status: 'active',
          message: 'Playbook heuristic active — পরবর্তী turn থেকে prompt-এ যুক্ত হবে।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const reject_playbook: AgentTool = {
  name: 'reject_playbook',
  description:
    'Owner rejects a proposed playbook heuristic — it will never enter the system prompt.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Playbook row id' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const id = String(input.id ?? '').trim()
    if (!id) return { success: false, error: 'id is required' }
    try {
      const row = await db.agentPlaybook.findUnique({ where: { id } })
      if (!row) return { success: false, error: 'playbook entry not found' }
      if (row.status === 'rejected') {
        return { success: true, data: { id, status: 'rejected', message: 'ইতিমধ্যে rejected।' } }
      }
      await db.agentPlaybook.update({
        where: { id },
        data: { status: 'rejected', reviewedAt: new Date() },
      })
      return { success: true, data: { id, status: 'rejected', message: 'Playbook heuristic rejected।' } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const retire_playbook: AgentTool = {
  name: 'retire_playbook',
  description:
    'Retire an active playbook heuristic that no longer applies — removes it from the system prompt.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Active playbook row id' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const id = String(input.id ?? '').trim()
    if (!id) return { success: false, error: 'id is required' }
    try {
      const row = await db.agentPlaybook.findUnique({ where: { id } })
      if (!row) return { success: false, error: 'playbook entry not found' }
      if (row.status !== 'active') {
        return { success: false, error: `Cannot retire status=${row.status}` }
      }
      await db.agentPlaybook.update({
        where: { id },
        data: { status: 'retired', reviewedAt: new Date() },
      })
      return { success: true, data: { id, status: 'retired', message: 'Playbook heuristic retired — prompt থেকে সরানো হবে।' } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const PLAYBOOK_TOOLS: AgentTool[] = [
  list_playbook,
  approve_playbook,
  reject_playbook,
  retire_playbook,
]

export const PLAYBOOK_ROLE_PROMPT = `
## Playbook (শেখা নিয়ম)
সাপ্তাহিক reflection থেকে proposed heuristics owner approve করলে active হয় — auto-active নয়।
- list_playbook → owner review
- approve_playbook / reject_playbook → proposed items
- retire_playbook → active কিন্তু আর প্রযোজ্য নয়
correlation ≠ causation — heuristic hypotheses, proven laws নয়।
`
