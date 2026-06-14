/**
 * Owner must approve Oxylabs credit spend before research tools run.
 */
import { createHash } from 'crypto'
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type OxylabsResearchTool =
  | 'web_research'
  | 'research_competitor'
  | 'research_seo_keywords'

const APPROVAL_TTL_MS = 30 * 60_000

export function estimateOxylabsCredits(tool: OxylabsResearchTool, input: Record<string, unknown>): number {
  if (tool === 'research_competitor') {
    return input.url ? 2 : 2
  }
  if (tool === 'web_research') {
    return String(input.mode ?? '') === 'fetch' ? 1 : 1
  }
  return 1
}

function stablePayload(tool: OxylabsResearchTool, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'web_research') {
    return {
      mode: String(input.mode ?? ''),
      query: String(input.query ?? '').trim(),
      url: String(input.url ?? '').trim(),
      limit: input.limit ?? null,
    }
  }
  if (tool === 'research_competitor') {
    return {
      competitorName: String(input.competitorName ?? '').trim(),
      url: String(input.url ?? '').trim(),
      product: String(input.product ?? '').trim(),
    }
  }
  return {
    keyword: String(input.keyword ?? '').trim(),
    productSlug: String(input.productSlug ?? '').trim(),
  }
}

export function oxylabsInputFingerprint(tool: OxylabsResearchTool, input: Record<string, unknown>): string {
  const payload = stablePayload(tool, input)
  return createHash('sha256').update(`${tool}:${JSON.stringify(payload)}`).digest('hex').slice(0, 24)
}

export async function verifyOxylabsSpendApproval(opts: {
  approvalId?: string | null
  tool: OxylabsResearchTool
  input: Record<string, unknown>
  conversationId?: string | null
}): Promise<{ ok: true; approvalId: string } | { ok: false; error: string; estimatedCredits: number }> {
  const estimatedCredits = estimateOxylabsCredits(opts.tool, opts.input)
  const approvalId = opts.approvalId ? String(opts.approvalId).trim() : ''
  if (!approvalId) {
    return {
      ok: false,
      estimatedCredits,
      error:
        `Oxylabs research-এর আগে confirm_oxylabs_spend দিয়ে owner-approval নিন (আনুমানিক ${estimatedCredits} ক্রেডিট খরচ)। ` +
        'Approve হলে spendApprovalId দিয়ে research tool চালান।',
    }
  }

  const row = await db.agentPendingAction.findUnique({ where: { id: approvalId } })
  if (!row || row.type !== 'oxylabs_spend') {
    return { ok: false, estimatedCredits, error: 'অবৈধ বা মেয়াদোত্তীর্ণ Oxylabs approval — confirm_oxylabs_spend আবার চালান।' }
  }
  if (row.status !== 'approved') {
    return {
      ok: false,
      estimatedCredits,
      error: row.status === 'pending'
        ? 'Owner এখনো Oxylabs খরচ approve করেননি — Approve বাটন চাপার পর আবার চেষ্টা করুন।'
        : `Oxylabs approval ${row.status} — নতুন confirm_oxylabs_spend লাগবে।`,
    }
  }

  const ageMs = Date.now() - new Date(row.createdAt).getTime()
  if (ageMs > APPROVAL_TTL_MS) {
    return { ok: false, estimatedCredits, error: 'Oxylabs approval ৩০ মিনিটের বেশি পুরনো — নতুন confirm_oxylabs_spend চালান।' }
  }

  const payload = row.payload as Record<string, unknown>
  if (String(payload.tool ?? '') !== opts.tool) {
    return { ok: false, estimatedCredits, error: 'Approval অন্য tool-এর জন্য — মিল রেখে confirm_oxylabs_spend আবার করুন।' }
  }

  const expectedFp = String(payload.inputFingerprint ?? '')
  const actualFp = oxylabsInputFingerprint(opts.tool, opts.input)
  if (expectedFp && expectedFp !== actualFp) {
    return { ok: false, estimatedCredits, error: 'Approval অন্য query/input-এর জন্য — নতুন confirm_oxylabs_spend লাগবে।' }
  }

  const conv = opts.conversationId ? String(opts.conversationId) : null
  const rowConv = row.conversationId ? String(row.conversationId) : null
  const payloadConv = payload.conversationId ? String(payload.conversationId) : null
  const allowedConv = rowConv ?? payloadConv
  if (allowedConv && conv && allowedConv !== conv) {
    return { ok: false, estimatedCredits, error: 'Approval অন্য conversation-এর — এই চ্যাটে নতুন confirm লাগবে।' }
  }

  return { ok: true, approvalId }
}

export async function consumeOxylabsApproval(approvalId: string): Promise<void> {
  await db.agentPendingAction.updateMany({
    where: { id: approvalId, status: 'approved' },
    data: { status: 'executed', resolvedAt: new Date() },
  })
}
