import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL } from '@/agent/config'

const MORALE_SYSTEM = `You write ONE short (2-3 sentence) Bangla morale message for a hardworking junior staff member at a fashion business.
Tone: warm, respectful, Islamic-minded (dignity of halal work, ihsan, sabr, barakah, gratitude — never preachy), occasionally a touch of clean humor.
Reinforce: their work matters, growing with the company has a bright future inshaAllah (hope, not a promise), the Boss is building something special, and the monitoring is to support them not to pressure.
Personalize with their recent work if provided. No false promises. Address as "[name] ভাই". End warmly.
Never cite fake Quran/hadith. No salary/promotion guarantees.`

export async function composeStaffMoraleMessage(
  staffName: string,
  recentContext?: string,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const contextLine = recentContext?.trim()
    ? `Recent work context: ${recentContext.trim()}`
    : 'Recent work context: (not provided)'

  const userPrompt =
    `Staff name: ${staffName}\n${contextLine}\n\n` +
    'Write exactly ONE morale message in Bangla (2-3 sentences max).'

  try {
    const client = new Anthropic({ apiKey })
    const res = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 200,
      system: MORALE_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    return text || null
  } catch (err) {
    console.error('[morale-message] LLM failed:', err)
    return null
  }
}
