import type Anthropic from '@anthropic-ai/sdk'
import type { AgentTool } from '@/agent/tools/registry'
import type { NeutralMsg, NeutralTool } from '@/agent/lib/models/types'

type StoredBlock = { type: string; text?: string; tool_use_id?: string; content?: string }

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
      .map((b) => `[Uploaded file path for tools: ${(b as { path?: string }).path ?? 'unknown'}]`)
      .join('\n')

    const combined = [fileParts, textParts].filter(Boolean).join('\n').trim()
    if (combined) {
      out.push({ role: row.role as 'user' | 'assistant', content: combined })
    }
  }
  return out
}

export function appendToolExchange(
  messages: NeutralMsg[],
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
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
      result: r.result,
    })),
  ]
}
