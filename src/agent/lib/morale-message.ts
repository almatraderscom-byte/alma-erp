import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL } from '@/agent/config'

const MORALE_SYSTEM = `One short (2-3 sentence) Bangla morale message for ALMA fashion staff.
Warm, respectful, Islamic-minded (ihsan, halal work dignity — not preachy). "আমরা/ALMA টিম" tone.
Personalize recent work if given. Address "[name] ভাই". No fake Quran/hadith, no promotion guarantees.`

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
