/**
 * POST /api/assistant/internal/generate-focus-plan
 * Generates AI daily focus plan using Anthropic. Worker sends context data.
 */
import { NextRequest, NextResponse } from 'next/server'
import { verifyAgentInternalToken } from '@/lib/agent-internal-auth'
import Anthropic from '@anthropic-ai/sdk'
import { enforceClaudeOnlyModel } from '@/agent/lib/models/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!verifyAgentInternalToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { context, today, dayName } = await req.json()
  if (!context) return NextResponse.json({ error: 'context required' }, { status: 400 })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ plan: null, error: 'no_api_key' })

  try {
    const anthropic = new Anthropic({ apiKey, timeout: 25_000 })
    const response = await anthropic.messages.create({
      model: enforceClaudeOnlyModel(),
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are a personal executive assistant for a business owner in Bangladesh. Based on the following context, create a focused daily plan in Bangla. Keep it concise (max 8 items), prioritize by urgency, and group into Morning/Afternoon/Evening. Use bullet points.

CONTEXT:
${context}

Reply ONLY with the daily plan in Bangla (no English, no preamble). Format: emoji + time block + items. End with one motivational line.`,
      }],
    })

    const plan = response.content[0]?.type === 'text' ? response.content[0].text : ''
    return NextResponse.json({ plan })
  } catch (err) {
    return NextResponse.json({ plan: null, error: String(err) })
  }
}
