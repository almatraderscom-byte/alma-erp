/**
 * CS customer agent turn — isolated from owner agent (core.ts).
 */
import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL, MAX_TOOL_ITERATIONS, calcCostUsd } from '@/agent/config'
import { buildCsCustomerPrompt } from '@/agent/lib/cs/customer-prompt'
import { CUSTOMER_TOOL_DEFINITIONS, executeCsTool } from '@/agent/tools/cs-registry'
import { appendCsMessage, loadCsHistory } from '@/agent/lib/cs/conversations'
import { logCost } from '@/agent/lib/cost-events'

export type CsReplyPart = { type: 'text'; text: string } | { type: 'image'; imageUrl: string }

export type CsTurnResult = {
  parts: CsReplyPart[]
  shadowOnly: boolean
  handedOff: boolean
  tokensIn: number
  tokensOut: number
  costUsd: number
}

const globalForAnthropic = globalThis as unknown as { anthropicCs: Anthropic | undefined }
function getClient(): Anthropic {
  if (!globalForAnthropic.anthropicCs) {
    globalForAnthropic.anthropicCs = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  }
  return globalForAnthropic.anthropicCs
}

function historyToMessages(rows: Array<{ role: string; content: unknown }>): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = []
  for (const row of rows) {
    const blocks = Array.isArray(row.content) ? row.content : [{ type: 'text', text: String(row.content) }]
    const textParts = blocks
      .map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text : null))
      .filter(Boolean)
      .join('\n')
    if (!textParts.trim()) continue
    if (row.role === 'user') out.push({ role: 'user', content: textParts })
    else if (row.role === 'assistant') out.push({ role: 'assistant', content: textParts })
  }
  return out
}

function buildUserContent(
  text: string,
  imageRef?: string,
  imageB64?: string,
  imageMime?: string,
): Anthropic.Messages.ContentBlockParam[] {
  const parts: Anthropic.Messages.ContentBlockParam[] = []
  if (imageB64 && imageMime) {
    parts.push({
      type: 'image',
      source: { type: 'base64', media_type: imageMime as 'image/jpeg', data: imageB64 },
    })
  }
  if (text) parts.push({ type: 'text', text })
  if (imageRef && !imageB64) parts.push({ type: 'text', text: `[Customer image: ${imageRef}]` })
  return parts.length ? parts : [{ type: 'text', text: text || '(empty)' }]
}

export async function runCsTurn(input: {
  csConversationId: string
  pageId: string
  psid: string
  userText: string
  imageRef?: string
  imageB64?: string
  imageMime?: string
  shadowOnly: boolean
}): Promise<CsTurnResult> {
  const system = buildCsCustomerPrompt()
  const history = await loadCsHistory(input.csConversationId, 24)
  let messages: Anthropic.Messages.MessageParam[] = historyToMessages(history)
  messages.push({
    role: 'user',
    content: buildUserContent(input.userText, input.imageRef, input.imageB64, input.imageMime),
  })

  const client = getClient()
  const parts: CsReplyPart[] = []
  let handedOff = false
  let tokensIn = 0
  let tokensOut = 0

  const ctx = {
    csConversationId: input.csConversationId,
    pageId: input.pageId,
    psid: input.psid,
  }

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const res = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 1024,
      system,
      tools: CUSTOMER_TOOL_DEFINITIONS,
      messages,
    })

    tokensIn += res.usage.input_tokens
    tokensOut += res.usage.output_tokens

    const toolUses = res.content.filter((b) => b.type === 'tool_use')
    const textBlocks = res.content.filter((b) => b.type === 'text')

    if (toolUses.length === 0) {
      for (const tb of textBlocks) {
        if (tb.type === 'text' && tb.text.trim()) parts.push({ type: 'text', text: tb.text.trim() })
      }
      break
    }

    messages.push({ role: 'assistant', content: res.content })
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

    for (const tu of toolUses) {
      if (tu.type !== 'tool_use') continue
      const result = await executeCsTool(tu.name, tu.input as Record<string, unknown>, ctx)
      if (tu.name === 'handoff_to_human' && result.success) handedOff = true
      if (tu.name === 'send_product_image' && result.success && result.data) {
        const d = result.data as { imageUrl?: string }
        if (d.imageUrl) parts.push({ type: 'image', imageUrl: d.imageUrl })
      }
      if (tu.name === 'match_product_by_image' && result.success && result.data) {
        const d = result.data as { matched?: boolean; imageUrl?: string; confidence?: string }
        if (d.matched && d.imageUrl && d.confidence === 'high') {
          parts.push({ type: 'image', imageUrl: d.imageUrl })
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  const costUsd = calcCostUsd({ input_tokens: tokensIn, output_tokens: tokensOut })
  void logCost({
    provider: 'anthropic',
    kind: 'cs_chat',
    units: { tokens_in: tokensIn, tokens_out: tokensOut, model: AGENT_MODEL },
    costUsd,
    conversationId: input.csConversationId,
    dedupKey: `cs_chat:${input.csConversationId}:${Date.now()}`,
  })

  const text = parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n\n')
  if (text) {
    await appendCsMessage(input.csConversationId, 'assistant', [{ type: 'text', text }])
  }

  return {
    parts: parts.length ? parts : [{ type: 'text', text: 'এক মিনিট, দেখে জানাচ্ছি 🙏' }],
    shadowOnly: input.shadowOnly,
    handedOff,
    tokensIn,
    tokensOut,
    costUsd,
  }
}
