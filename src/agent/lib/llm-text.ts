/**
 * One-shot text generation for internal helpers (ads optimizer, marketing
 * planner/report, compaction summaries, captions) — Anthropic when it has
 * credits, otherwise Gemini.
 *
 * Owner decision 2026-07: Gemini 3.1 Pro replaces Claude Sonnet everywhere
 * "for now". These helper paths used to call the Anthropic SDK directly with
 * AGENT_MODEL; with Anthropic credits exhausted every such call 400'd
 * ("credit balance too low") and the FEATURE failed — e.g. recommend_ad_actions
 * died mid-tool. This wrapper keeps the Anthropic path ready for Claude's
 * return (flip ANTHROPIC_HEAD_DOWN=false) while Gemini carries the work today.
 */
import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL } from '@/agent/config'
import { geminiGenerateText } from '@/agent/lib/gemini-text'

export async function agentSmartText(opts: {
  system: string
  prompt: string
  maxTokens?: number
  temperature?: number
  /** Cost attribution label for the Gemini path (units.purpose). */
  costLabel: string
  conversationId?: string | null
}): Promise<string> {
  // Env kill-switch AND the owner's per-model Monitor toggle both gate Claude.
  const { isAnthropicAllowed } = await import('@/agent/lib/models/model-enabled')
  const anthropicAllowed = await isAnthropicAllowed(AGENT_MODEL || 'claude-sonnet-4-6').catch(() => false)
  if (anthropicAllowed && process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const res = await client.messages.create({
        model: AGENT_MODEL || 'claude-sonnet-4-6',
        max_tokens: opts.maxTokens ?? 1024,
        system: opts.system,
        messages: [{ role: 'user', content: opts.prompt }],
      })
      const block = res.content.find((b) => b.type === 'text')
      const text = block && block.type === 'text' ? block.text.trim() : ''
      if (text) return text
    } catch (err) {
      console.warn(
        `[llm-text] anthropic failed for ${opts.costLabel}, falling back to gemini:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  const text = await geminiGenerateText({
    prompt: `${opts.system}\n\n${opts.prompt}`,
    costLabel: opts.costLabel,
    maxTokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.3,
    conversationId: opts.conversationId ?? null,
  })
  return text.trim()
}
