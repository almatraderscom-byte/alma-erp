/**
 * CS customer agent turn — isolated from owner agent (core.ts).
 *
 * Model policy (owner decision 2026-07): Claude runs the CS turn only while it
 * has credits (`isAnthropicAllowed`). Otherwise the SAME tool loop runs through
 * the neutral adapter on Qwen (or-qwen3-max — customer-facing Bangla quality),
 * falling back to native Gemini when OpenRouter fails. The old unconditional
 * Anthropic call 400'd under ANTHROPIC_HEAD_DOWN and live CS died.
 */
import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL, MAX_TOOL_ITERATIONS, calcCostUsd } from '@/agent/config'
import { buildCsCustomerPrompt } from '@/agent/lib/cs/customer-prompt'
import { CUSTOMER_TOOL_DEFINITIONS, executeCsTool } from '@/agent/tools/cs-registry'
import { appendCsMessage, loadCsHistory } from '@/agent/lib/cs/conversations'
import { loadCsCustomer, formatCustomerContextForPrompt } from '@/agent/lib/cs/customers'
import { logCost } from '@/agent/lib/cost-events'
import { getModel, isKnownModelId, type ModelEntry } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { adapterFor } from '@/agent/lib/models/adapters'
import { anthropicToolsToNeutral } from '@/agent/lib/models/neutral'
import type { NeutralMsg } from '@/agent/lib/models/types'
import { gateCheapModelBanglaOutput } from '@/agent/lib/models/bangla-output-gate'

export type CsReplyPart = { type: 'text'; text: string } | { type: 'image'; imageUrl: string }

export type CsFollowupHint =
  | { type: 'price_no_reply'; productLabel: string; stockLow: boolean }
  | { type: 'half_order' }

export type CsTurnResult = {
  parts: CsReplyPart[]
  shadowOnly: boolean
  handedOff: boolean
  tokensIn: number
  tokensOut: number
  costUsd: number
  followupHints: CsFollowupHint[]
  hadToolUse: boolean
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

type CsTurnInput = {
  csConversationId: string
  pageId: string
  psid: string
  userText: string
  imageRef?: string
  imageB64?: string
  imageMime?: string
  shadowOnly: boolean
}

type CsLoopState = {
  parts: CsReplyPart[]
  followupHints: CsFollowupHint[]
  handedOff: boolean
  usedOrderDraft: boolean
}

/** Shared per-tool side effects (both the Claude and the adapter loop). */
async function noteCsToolResult(
  state: CsLoopState,
  input: CsTurnInput,
  name: string,
  result: { success: boolean; data?: unknown },
): Promise<void> {
  if (name === 'handoff_to_human' && result.success) state.handedOff = true
  if (name === 'create_order_draft') state.usedOrderDraft = true
  if (name === 'get_product_details' && result.success && result.data) {
    const d = result.data as { code?: string; name?: string; stock?: number }
    if (d.code) {
      const { recordCsEvent } = await import('@/agent/lib/cs/analytics')
      void recordCsEvent('product_asked', {
        conversationId: input.csConversationId,
        metadata: { code: d.code },
      })
      const priceAsked = /দাম|price|কত|koto/i.test(input.userText)
      if (priceAsked && d.name) {
        state.followupHints.push({
          type: 'price_no_reply',
          productLabel: d.name,
          stockLow: (d.stock ?? 99) <= 3,
        })
      }
    }
  }
  if (name === 'send_product_image' && result.success && result.data) {
    const d = result.data as { imageUrl?: string }
    if (d.imageUrl) state.parts.push({ type: 'image', imageUrl: d.imageUrl })
  }
  if (name === 'match_product_by_image' && result.success && result.data) {
    const d = result.data as { matched?: boolean; imageUrl?: string; confidence?: string }
    if (d.matched && d.imageUrl && d.confidence === 'high') {
      state.parts.push({ type: 'image', imageUrl: d.imageUrl })
    }
  }
}

/** CS worker models when Claude is down: Qwen first, native Gemini fallback. */
function csAdapterModels(): ModelEntry[] {
  const models: ModelEntry[] = []
  if (process.env.OPENROUTER_API_KEY?.trim() && isKnownModelId('or-qwen3-max')) {
    const qwen = getModel('or-qwen3-max')
    if (qwen.supportsTools) models.push(qwen)
  }
  if (isKnownModelId('gemini-3.1-pro')) models.push(getModel('gemini-3.1-pro'))
  return models
}

async function runCsLoopViaAdapter(
  model: ModelEntry,
  system: string,
  history: NeutralMsg[],
  userText: string,
  input: CsTurnInput,
  state: CsLoopState,
): Promise<{ finalText: string; tokensIn: number; tokensOut: number; cacheRead: number; hadToolUse: boolean }> {
  const adapter = adapterFor(model.provider)
  const tools = anthropicToolsToNeutral(CUSTOMER_TOOL_DEFINITIONS)
  let messages: NeutralMsg[] = [...history, { role: 'user', content: userText }]
  let tokensIn = 0
  let tokensOut = 0
  let cacheRead = 0
  let finalText = ''
  let hadToolUse = false
  const ctx = {
    csConversationId: input.csConversationId,
    pageId: input.pageId,
    psid: input.psid,
  }

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const calls: Array<{ id: string; name: string; input: Record<string, unknown>; thoughtSignature?: string }> = []
    const toolNames = new Map<string, string>()
    let iterationText = ''

    for await (const ev of adapter.streamTurn({
      apiModel: model.apiModel,
      system,
      messages,
      tools,
      thinking: model.thinking,
    })) {
      if (ev.type === 'text_delta') iterationText += ev.text
      else if (ev.type === 'tool_start') toolNames.set(ev.id, ev.name)
      else if (ev.type === 'tool_input') {
        calls.push({
          id: ev.id,
          name: toolNames.get(ev.id) ?? ev.id,
          input: ev.input,
          thoughtSignature: ev.thoughtSignature,
        })
      } else if (ev.type === 'usage') {
        tokensIn += ev.inputTokens
        tokensOut += ev.outputTokens
        cacheRead += ev.cacheRead ?? 0
      }
    }

    if (iterationText.trim()) finalText = iterationText.trim()
    if (calls.length === 0) break

    hadToolUse = true
    messages = [...messages, { role: 'assistant', toolCalls: calls }]
    for (const call of calls) {
      const result = await executeCsTool(call.name, call.input, ctx)
      await noteCsToolResult(state, input, call.name, result)
      messages = [...messages, { role: 'tool', toolCallId: call.id, name: call.name, result }]
    }
  }

  return { finalText, tokensIn, tokensOut, cacheRead, hadToolUse }
}

async function runCsTurnAdapter(input: CsTurnInput, system: string): Promise<CsTurnResult> {
  const history = await loadCsHistory(input.csConversationId, 24)
  const neutralHistory: NeutralMsg[] = historyToMessages(history)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: String(m.content),
    }))

  // NeutralMsg user turns are text-only: reference the customer image so the
  // model reaches for match_product_by_image (which loads the bytes itself).
  let userText = input.userText || ''
  if (input.imageRef) userText = `${userText}\n[Customer image: ${input.imageRef}]`.trim()
  else if (input.imageB64) userText = `${userText}\n[Customer sent an image]`.trim()
  if (!userText) userText = '(empty)'

  const state: CsLoopState = { parts: [], followupHints: [], handedOff: false, usedOrderDraft: false }
  const models = csAdapterModels()
  if (!models.length) throw new Error('cs adapter: no non-Anthropic model available (OPENROUTER_API_KEY / GEMINI_API_KEY missing)')

  let lastErr: unknown = null
  for (const model of models) {
    // Reset per attempt so a half-failed Qwen run can't leak parts into Gemini's.
    state.parts = []
    state.followupHints = []
    state.handedOff = false
    state.usedOrderDraft = false
    try {
      const run = await runCsLoopViaAdapter(model, system, neutralHistory, userText, input, state)
      // Customer-facing Bangla quality gate applies to every cheap-model reply.
      const gated = run.finalText ? gateCheapModelBanglaOutput(run.finalText, { customerFacing: true }) : ''
      if (gated) state.parts.push({ type: 'text', text: gated })

      const costUsd = calcModelTurnCostUsd(model, {
        inputTokens: run.tokensIn,
        outputTokens: run.tokensOut,
        cacheRead: run.cacheRead,
      })
      void logCost({
        provider: model.provider === 'google' ? 'gemini' : 'openai',
        kind: 'cs_chat',
        units: { tokens_in: run.tokensIn, tokens_out: run.tokensOut, model: model.id },
        costUsd,
        conversationId: input.csConversationId,
        dedupKey: `cs_chat:${input.csConversationId}:${Date.now()}`,
      })

      return finishCsTurn(input, state, {
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        costUsd,
        hadToolUse: run.hadToolUse,
      })
    } catch (err) {
      lastErr = err
      console.warn(`[cs-core] adapter model ${model.id} failed:`, err instanceof Error ? err.message : err)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function finishCsTurn(
  input: CsTurnInput,
  state: CsLoopState,
  usage: { tokensIn: number; tokensOut: number; costUsd: number; hadToolUse: boolean },
): Promise<CsTurnResult> {
  const orderHints = /ঠিকানা|ফোন|phone|address|সাইজ|size/i.test(input.userText)
  if (orderHints && !state.usedOrderDraft && input.userText.trim().length > 5) {
    state.followupHints.push({ type: 'half_order' })
  }

  const text = state.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
  if (text) {
    await appendCsMessage(input.csConversationId, 'assistant', [{ type: 'text', text }])
  }

  return {
    parts: state.parts.length ? state.parts : [{ type: 'text', text: 'এক মিনিট, দেখে জানাচ্ছি 🙏' }],
    shadowOnly: input.shadowOnly,
    handedOff: state.handedOff,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd: usage.costUsd,
    followupHints: state.followupHints,
    hadToolUse: usage.hadToolUse,
  }
}

export async function runCsTurn(input: CsTurnInput): Promise<CsTurnResult> {
  const customer = await loadCsCustomer(input.pageId, input.psid)
  const system = buildCsCustomerPrompt(input.pageId) + formatCustomerContextForPrompt(customer)

  const { isAnthropicAllowed } = await import('@/agent/lib/models/model-enabled')
  const anthropicAllowed = await isAnthropicAllowed(AGENT_MODEL).catch(() => false)
  if (!anthropicAllowed || !process.env.ANTHROPIC_API_KEY) {
    return runCsTurnAdapter(input, system)
  }

  const history = await loadCsHistory(input.csConversationId, 24)
  const messages: Anthropic.Messages.MessageParam[] = historyToMessages(history)
  messages.push({
    role: 'user',
    content: buildUserContent(input.userText, input.imageRef, input.imageB64, input.imageMime),
  })

  const client = getClient()
  const state: CsLoopState = { parts: [], followupHints: [], handedOff: false, usedOrderDraft: false }
  let hadToolUse = false
  let tokensIn = 0
  let tokensOut = 0

  const ctx = {
    csConversationId: input.csConversationId,
    pageId: input.pageId,
    psid: input.psid,
  }

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1]
      if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
        const lb = lastMsg.content[lastMsg.content.length - 1]
        ;(lb as { cache_control?: { type: 'ephemeral' } }).cache_control = { type: 'ephemeral' }
      }
    }

    const res = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 1024,
      system: [{ type: 'text' as const, text: String(system), cache_control: { type: 'ephemeral' } }],
      tools: CUSTOMER_TOOL_DEFINITIONS,
      messages,
    })

    tokensIn += res.usage.input_tokens
    tokensOut += res.usage.output_tokens

    const toolUses = res.content.filter((b) => b.type === 'tool_use')
    const textBlocks = res.content.filter((b) => b.type === 'text')

    if (toolUses.length === 0) {
      for (const tb of textBlocks) {
        if (tb.type === 'text' && tb.text.trim()) state.parts.push({ type: 'text', text: tb.text.trim() })
      }
      break
    }

    hadToolUse = true
    messages.push({ role: 'assistant', content: res.content })
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

    for (const tu of toolUses) {
      if (tu.type !== 'tool_use') continue
      const result = await executeCsTool(tu.name, tu.input as Record<string, unknown>, ctx)
      await noteCsToolResult(state, input, tu.name, result)
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

  return finishCsTurn(input, state, { tokensIn, tokensOut, costUsd, hadToolUse })
}
