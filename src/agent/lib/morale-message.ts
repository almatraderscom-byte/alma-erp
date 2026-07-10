import { agentSmartText } from '@/agent/lib/llm-text'

const MORALE_SYSTEM = `One short (2-3 sentence) Bangla morale message for ALMA fashion staff.
Warm, respectful, Islamic-minded (ihsan, halal work dignity — not preachy). "আমরা/ALMA টিম" tone.
Personalize recent work if given. Address "[name] ভাই". No fake Quran/hadith, no promotion guarantees.`

export async function composeStaffMoraleMessage(
  staffName: string,
  recentContext?: string,
): Promise<string | null> {
  const contextLine = recentContext?.trim()
    ? `Recent work context: ${recentContext.trim()}`
    : 'Recent work context: (not provided)'

  const userPrompt =
    `Staff name: ${staffName}\n${contextLine}\n\n` +
    'Write exactly ONE morale message in Bangla (2-3 sentences max).'

  try {
    // Anthropic when it has credits, otherwise Gemini — a direct Claude call here
    // 400'd while ANTHROPIC_HEAD_DOWN is on and silently killed morale messages.
    const text = await agentSmartText({
      system: MORALE_SYSTEM,
      prompt: userPrompt,
      maxTokens: 200,
      costLabel: 'morale_message',
    })
    return text || null
  } catch (err) {
    console.error('[morale-message] LLM failed:', err)
    return null
  }
}
