/**
 * Skill Engine V2 — a diagnostic, not a feature.
 *
 * Live finding 2026-07-27: with the engine switched ON in production and an
 * OWNER pin written straight into `agent_conversations.pinned_skill`, a real
 * production turn still emitted no `skill_pinned` event.
 *
 * Round one asked whether the SKILL.md packages reach the deployed lambda at
 * all. From production, the answer was yes — 20 directories, 5 active skills,
 * no warnings, and the probe sentence routes by rule. So the measurement moved
 * into the CHAT lambda, where the turn actually runs; see the GET on
 * `/api/assistant/chat` and `skill-engine/probe.ts`.
 *
 * Internal-token only, read-only, no model call, no cost. It carries its own
 * `outputFileTracingIncludes` entry in next.config.js — a probe that traced the
 * files differently from the chat route would answer a question nobody asked.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { verifyAgentInternalToken, extractBearerToken } from '@/lib/agent-internal-auth'
import { skillDiskSnapshot } from '@/agent/lib/skill-engine/probe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  return Response.json(
    await skillDiskSnapshot({
      probe: req.nextUrl.searchParams.get('probe'),
      conversationId: req.nextUrl.searchParams.get('conversationId'),
      includeActive: req.nextUrl.searchParams.get('active') === '1',
    }),
  )
}
