import type Anthropic from '@anthropic-ai/sdk'
import type { AgentTool } from '@/agent/tools/registry'
import type { NeutralMsg, NeutralTool } from '@/agent/lib/models/types'

type StoredBlock = { type: string; text?: string; tool_use_id?: string; content?: string; path?: string; summary?: string; status?: string }

export function toolsToNeutral(tools: AgentTool[]): NeutralTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.input_schema as object,
  }))
}

export function anthropicToolsToNeutral(tools: Anthropic.Messages.Tool[]): NeutralTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    schema: t.input_schema as object,
  }))
}

export function systemBlocksToText(blocks: Anthropic.Messages.TextBlockParam[]): string {
  return blocks.map((b) => b.text).join('\n\n')
}

export function dbRowsToNeutral(
  rows: Array<{ role: string; content: unknown }>,
): NeutralMsg[] {
  const out: NeutralMsg[] = []
  for (const row of rows) {
    const stored = row.content
    if (!Array.isArray(stored)) {
      const text = String(stored ?? '').trim()
      if (text) out.push({ role: row.role as 'user' | 'assistant', content: text })
      continue
    }

    const blocks = stored as StoredBlock[]
    const textParts = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
    const fileParts = blocks
      .filter((b) => b.type === 'file_ref')
      .map((b) => `[Uploaded file path for tools: ${b.path ?? 'unknown'}]`)
      .join('\n')
    // Confirm-card breadcrumbs (call/finance approval cards). The native Claude
    // path keeps these as a short note so the head remembers WHAT was approved;
    // the cheap-head path used to DROP them, so a model switched into mid-thread
    // (e.g. DeepSeek) lost the approval context and got confused about whether a
    // call/action ever happened. Mirror the Claude path here, and add the resolved
    // status when present so the new head also knows the outcome.
    const cardParts = blocks
      .filter((b) => b.type === 'confirm_card')
      .map((b) => {
        const status = b.status && b.status !== 'pending' ? ` — ${b.status}` : ''
        return `[অনুমোদনের কার্ড দেখানো হয়েছিল: ${b.summary ?? ''}${status}]`
      })
      .join('\n')

    const combined = [fileParts, textParts, cardParts].filter(Boolean).join('\n').trim()
    if (combined) {
      out.push({ role: row.role as 'user' | 'assistant', content: combined })
    }
  }
  return out
}

// A tool result is re-shipped to the model on EVERY subsequent iteration of the
// turn. Unbounded payloads (live_browser DOM dumps, big ERP lists) ballooned a
// single multi-tool turn to 500k+ billed tokens on non-caching heads. 12k chars
// (~3k tokens) keeps everything a model actually needs from a single result.
const MAX_TOOL_RESULT_CHARS = 12_000

function capToolResult(result: unknown): unknown {
  try {
    const s = typeof result === 'string' ? result : JSON.stringify(result)
    if (s.length <= MAX_TOOL_RESULT_CHARS) return result
    return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${s.length - MAX_TOOL_RESULT_CHARS} chars — result was too large; ask for a narrower slice if you need more]`
  } catch {
    return result
  }
}

export function appendToolExchange(
  messages: NeutralMsg[],
  calls: Array<{ id: string; name: string; input: Record<string, unknown>; thoughtSignature?: string }>,
  results: Array<{ id: string; name: string; result: unknown }>,
): NeutralMsg[] {
  if (calls.length === 0) return messages
  return [
    ...messages,
    { role: 'assistant', toolCalls: calls },
    ...results.map((r) => ({
      role: 'tool' as const,
      toolCallId: r.id,
      name: r.name,
      result: capToolResult(r.result),
    })),
  ]
}
