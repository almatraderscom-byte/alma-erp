/**
 * POST /api/assistant/internal/generate-report
 * Generates AI-powered reports using Anthropic. Worker sends data context.
 */
import { NextRequest, NextResponse } from 'next/server'
import { verifyAgentInternalToken } from '@/lib/agent-internal-auth'
import { requireAgentEnabled } from '@/agent/lib/guards'
import Anthropic from '@anthropic-ai/sdk'
import { enforceClaudeOnlyModel } from '@/agent/lib/models/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MAX_DATA_CHARS = 50_000
const MAX_ANOMALIES = 20
const ALLOWED_TYPES = new Set(['weekly-bi'])

const PROMPTS: Record<string, (data: string, anomalies: string[]) => string> = {
  'weekly-bi': (data, anomalies) =>
    `You are a business intelligence analyst for a Bangladeshi e-commerce clothing brand (Alma Lifestyle). Generate a weekly business report in Bangla. Be concise, use bullet points and emojis. Highlight anomalies if any.

DATA:
${data}
${anomalies?.length ? `\nANOMALIES: ${anomalies.join(', ')}` : ''}

Format: Sections with emoji headers. Key metrics first, then insights. End with 2-3 action items for next week. All in Bangla.`,
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!verifyAgentInternalToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { type, data, anomalies } = await req.json()
  if (!type || !data) return NextResponse.json({ error: 'type and data required' }, { status: 400 })
  if (!ALLOWED_TYPES.has(type)) {
    return NextResponse.json({ error: `Unknown report type: ${type}` }, { status: 400 })
  }
  if (String(data).length > MAX_DATA_CHARS) {
    return NextResponse.json({ error: 'data_too_large' }, { status: 400 })
  }

  const anomalyList = Array.isArray(anomalies) ? anomalies.slice(0, MAX_ANOMALIES).map(String) : []

  const promptFn = PROMPTS[type]
  if (!promptFn) return NextResponse.json({ error: `Unknown report type: ${type}` }, { status: 400 })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ report: null, error: 'no_api_key' })

  try {
    const anthropic = new Anthropic({ apiKey, timeout: 25_000 })
    const response = await anthropic.messages.create({
      model: enforceClaudeOnlyModel(),
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: promptFn(String(data), anomalyList),
      }],
    })

    const report = response.content[0]?.type === 'text' ? response.content[0].text : ''
    return NextResponse.json({ report })
  } catch (err) {
    return NextResponse.json({ report: null, error: String(err) })
  }
}
