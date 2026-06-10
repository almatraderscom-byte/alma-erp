import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL, MAX_TOOL_ITERATIONS, calcCostUsd } from '@/agent/config'
import { buildSystemPrompt } from '@/agent/lib/system-prompt'
import { TOOL_DEFINITIONS, executeTool } from '@/agent/tools/registry'

// ── Event types emitted by the agent loop ──────────────────────────────────

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_end'; id: string; name: string; success: boolean; error?: string }
  | { type: 'done'; messageId: string; tokensIn: number; tokensOut: number; costUsd: number }
  | { type: 'error'; message: string }

// ── Anthropic client (singleton per serverless isolate) ────────────────────

const globalForAnthropic = globalThis as unknown as { anthropic: Anthropic | undefined }
function getClient(): Anthropic {
  if (!globalForAnthropic.anthropic) {
    globalForAnthropic.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    })
  }
  return globalForAnthropic.anthropic
}

// ── Helpers ────────────────────────────────────────────────────────────────

type ApiMessage = Anthropic.Messages.MessageParam

// Collected content block (simplified — avoids SDK response vs param mismatch).
type CollectedBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

/** Loads conversation history from DB and converts to Anthropic message format. */
async function loadHistory(conversationId: string): Promise<ApiMessage[]> {
  const rows = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  })
  return rows.map((row) => ({
    role: row.role as 'user' | 'assistant',
    content: row.content as unknown as Anthropic.Messages.ContentBlockParam[],
  }))
}

/** Marks the last user turn with cache_control for prompt caching. */
function applyCacheControl(messages: ApiMessage[]): ApiMessage[] {
  // Find the last user message and cache its last content block.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const msg = messages[i]
    const rawContent = msg.content
    const blocks: Anthropic.Messages.ContentBlockParam[] = Array.isArray(rawContent)
      ? [...rawContent]
      : typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : []
    if (blocks.length === 0) break
    const last = blocks[blocks.length - 1]
    blocks[blocks.length - 1] = {
      ...last,
      cache_control: { type: 'ephemeral' },
    } as Anthropic.Messages.ContentBlockParam
    const patched: ApiMessage = { role: 'user', content: blocks }
    return [
      ...messages.slice(0, i),
      patched,
      ...messages.slice(i + 1),
    ]
  }
  return messages
}

// ── Main agent turn ────────────────────────────────────────────────────────

/**
 * Runs one full agent turn for a conversation.
 * The latest user message must already be saved to DB before calling this.
 * Yields AgentEvents as the turn progresses (text deltas, tool signals, done).
 */
export async function* runAgentTurn(
  conversationId: string,
): AsyncGenerator<AgentEvent> {
  const client = getClient()

  // Accumulate full turn usage across all iterations (tool loops share a turn).
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheCreationTokens = 0
  let totalCacheReadTokens = 0

  // Messages array we build up across tool iterations.
  let messages: ApiMessage[] = await loadHistory(conversationId)

  // Collect content blocks for each assistant reply so we can persist them.
  // assistantTurns mirrors the tool-loop — each entry is one Claude reply.
  const assistantTurns: CollectedBlock[][] = []

  // Tool call records to persist.
  type ToolRecord = {
    id: string
    toolName: string
    input: Record<string, unknown>
    output: Record<string, unknown> | null
    status: 'success' | 'error'
    durationMs: number
    error: string | null
  }
  const toolRecords: ToolRecord[] = []

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const apiMessages = applyCacheControl(messages)

      const stream = client.messages.stream({
        model: AGENT_MODEL,
        max_tokens: 8192,
        thinking: { type: 'adaptive' },
        system: buildSystemPrompt(),
        tools: TOOL_DEFINITIONS,
        messages: apiMessages,
      })

      // Collect the current assistant reply blocks.
      const currentBlocks: CollectedBlock[] = []
      let activeBlockType: string | null = null
      let activeBlockText = ''
      let activeBlockId = ''
      let activeBlockName = ''
      let activeBlockInputJson = ''

      for await (const event of stream) {
        if (event.type === 'message_start') {
          const u = event.message.usage
          totalInputTokens += u.input_tokens
          totalOutputTokens += u.output_tokens
          totalCacheCreationTokens += (u as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0
          totalCacheReadTokens += (u as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0
        } else if (event.type === 'message_delta') {
          const u = event.usage
          if (u) totalOutputTokens += u.output_tokens
        } else if (event.type === 'content_block_start') {
          const block = event.content_block
          activeBlockType = block.type
          if (block.type === 'text') {
            activeBlockText = ''
          } else if (block.type === 'tool_use') {
            activeBlockId = block.id
            activeBlockName = block.name
            activeBlockInputJson = ''
            yield { type: 'tool_start', id: block.id, name: block.name }
          } else if (block.type === 'thinking') {
            // Thinking blocks are streamed but not forwarded to client.
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            activeBlockText += delta.text
            yield { type: 'text_delta', delta: delta.text }
          } else if (delta.type === 'input_json_delta') {
            activeBlockInputJson += delta.partial_json
          }
          // thinking_delta: intentionally ignored (not forwarded)
        } else if (event.type === 'content_block_stop') {
          if (activeBlockType === 'text') {
            currentBlocks.push({ type: 'text', text: activeBlockText })
          } else if (activeBlockType === 'tool_use') {
            let parsedInput: Record<string, unknown> = {}
            try {
              parsedInput = JSON.parse(activeBlockInputJson || '{}')
            } catch {
              parsedInput = { _raw: activeBlockInputJson }
            }
            currentBlocks.push({
              type: 'tool_use',
              id: activeBlockId,
              name: activeBlockName,
              input: parsedInput,
            })
          }
          // Thinking blocks: not stored in DB (privacy).
        }
      }

      assistantTurns.push(currentBlocks)

      // Check if we should stop: no tool use.
      const toolUseBlocks = currentBlocks.filter(
        (b): b is Extract<CollectedBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )

      if (toolUseBlocks.length === 0) break

      // Add assistant reply to the messages array for the next iteration.
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: currentBlocks as unknown as Anthropic.Messages.ContentBlockParam[],
        },
      ]

      // Execute each tool and collect results.
      const toolResultContent: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const tb of toolUseBlocks) {
        const started = Date.now()
        const result = await executeTool(tb.name, tb.input)
        const durationMs = Date.now() - started

        toolRecords.push({
          id: tb.id,
          toolName: tb.name,
          input: tb.input,
          output: result.data !== undefined ? { data: result.data } : null,
          status: result.success ? 'success' : 'error',
          durationMs,
          error: result.error ?? null,
        })

        yield {
          type: 'tool_end',
          id: tb.id,
          name: tb.name,
          success: result.success,
          error: result.error,
        }

        toolResultContent.push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: JSON.stringify(result),
        })
      }

      // Add tool results as user turn for the next iteration.
      messages = [
        ...messages,
        { role: 'user', content: toolResultContent },
      ]
    }

    // ── Persist assistant message (last reply only, text blocks) ──────────
    // We store content as the final text-only view; full content could include
    // tool_use blocks from intermediate iterations.
    const textContent = assistantTurns
      .flat()
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    const storedContent: Anthropic.Messages.ContentBlockParam[] =
      textContent.length > 0 ? textContent : [{ type: 'text', text: '' }]

    const costUsd = calcCostUsd({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cache_creation_input_tokens: totalCacheCreationTokens,
      cache_read_input_tokens: totalCacheReadTokens,
    })

    const usageData = {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cache_creation_input_tokens: totalCacheCreationTokens,
      cache_read_input_tokens: totalCacheReadTokens,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const savedMsg = await db.agentMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content: storedContent,
        tokensIn: totalInputTokens,
        tokensOut: totalOutputTokens,
        costUsd,
        usage: usageData,
      },
    })

    // Persist tool call records.
    if (toolRecords.length > 0) {
      await db.agentToolCall.createMany({
        data: toolRecords.map((r: ToolRecord) => ({
          messageId: savedMsg.id,
          toolName: r.toolName,
          input: r.input,
          output: r.output,
          status: r.status,
          durationMs: r.durationMs,
          error: r.error,
        })),
      })
    }

    // Update conversation updatedAt.
    await prisma.agentConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    })

    yield {
      type: 'done',
      messageId: savedMsg.id,
      tokensIn: totalInputTokens,
      tokensOut: totalOutputTokens,
      costUsd,
    }
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}
