/**
 * SK-1 item 2 — score REAL runs, isolated vs inline.
 *
 * `compareToBaseline()` has existed since SK-1 and has never been pointed at a
 * real run, because nothing could read one. This route is the missing half: it
 * lists the conversations that actually pinned a skill, reconstructs each into
 * the `EvalRun` shape the scorer takes, and answers the one question that
 * gates isolation — *did anything get WORSE?*
 *
 * Read-only. It scores what already happened; it never runs the agent.
 *
 *   GET  /api/assistant/skills/evals                 → recent runs with a pinned skill
 *   GET  /api/assistant/skills/evals?conversation=X  → that run, reconstructed
 *   POST { arms: { withSkill: [{scenarioId, conversationId}], baseline: [...] } }
 *        → per-arm results + the regression gate
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { ALL_SCENARIOS } from '@/agent/lib/skill-engine/evals/scenarios'
import { compareToBaseline, scoreRun, type EvalResult } from '@/agent/lib/skill-engine/evals/scoring'
import { reconstructRun } from '@/agent/lib/skill-engine/evals/from-conversation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

async function loadRun(conversationId: string) {
  const conv = await db.agentConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, title: true, pinnedSkill: true, skillRouteTrace: true, updatedAt: true },
  })
  if (!conv) return null

  const messages = await db.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, createdAt: true },
  })
  const toolCalls = await db.agentToolCall.findMany({
    where: { messageId: { in: messages.map((m: { id: string }) => m.id) } },
    orderBy: { createdAt: 'asc' },
    select: { toolName: true, status: true },
  })

  return {
    conversation: conv,
    messageCount: messages.length,
    run: reconstructRun({ pinnedSkill: conv.pinnedSkill, messages, toolCalls }),
  }
}

export async function GET(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  const conversationId = req.nextUrl.searchParams.get('conversation')
  try {
    if (conversationId) {
      const loaded = await loadRun(conversationId)
      if (!loaded) return Response.json({ error: 'not_found' }, { status: 404 })
      return Response.json(loaded)
    }

    // The index: every conversation that ever pinned a skill, newest first.
    // This is how a run gets FOUND — the comparison is worthless if the two arms
    // are not the same job, so the arms are chosen by eye from this list.
    const limit = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 40, 100)
    const rows = await db.agentConversation.findMany({
      where: { pinnedSkill: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: { id: true, title: true, pinnedSkill: true, skillRouteTrace: true, updatedAt: true },
    })
    return Response.json({ scenarios: ALL_SCENARIOS.map((s) => ({ id: s.id, text: s.text, expectSkill: s.expectSkill })), conversations: rows })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

interface ArmEntry {
  scenarioId?: string
  conversationId?: string
}

async function scoreArm(entries: ArmEntry[]): Promise<{ results: EvalResult[]; detail: unknown[] }> {
  const results: EvalResult[] = []
  const detail: unknown[] = []
  for (const e of entries) {
    const scenario = ALL_SCENARIOS.find((s) => s.id === e.scenarioId)
    if (!scenario || !e.conversationId) {
      detail.push({ ...e, error: 'unknown scenarioId or missing conversationId' })
      continue
    }
    const loaded = await loadRun(e.conversationId)
    if (!loaded) {
      detail.push({ ...e, error: 'conversation not found' })
      continue
    }
    const result = scoreRun(scenario, loaded.run)
    results.push(result)
    detail.push({
      scenarioId: scenario.id,
      conversationId: e.conversationId,
      pinnedSkill: loaded.run.pinnedSkill,
      toolNames: loaded.run.tools.map((t) => `${t.toolName}:${t.status}`),
      replyChars: loaded.run.replyText.length,
      result,
    })
  }
  return { results, detail }
}

export async function POST(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as {
    arms?: { withSkill?: ArmEntry[]; baseline?: ArmEntry[] }
  }
  const withSkillEntries = body.arms?.withSkill ?? []
  const baselineEntries = body.arms?.baseline ?? []
  if (withSkillEntries.length === 0) {
    return Response.json({ error: 'arms.withSkill required' }, { status: 400 })
  }

  try {
    const a = await scoreArm(withSkillEntries)
    const b = await scoreArm(baselineEntries)
    return Response.json({
      withSkill: a.detail,
      baseline: b.detail,
      // `regressed` non-empty is the blocker, however good the average looks.
      comparison: compareToBaseline(a.results, b.results),
    })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
