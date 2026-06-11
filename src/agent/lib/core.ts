import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL, MAX_TOOL_ITERATIONS, calcCostUsd } from '@/agent/config'
import { buildSystemPrompt, type PinnedMemory, type RelevantMemory } from '@/agent/lib/system-prompt'
import { TOOL_DEFINITIONS, executeTool } from '@/agent/tools/registry'
import { agentStorageDownload } from '@/agent/lib/storage'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'

// ── Event types ────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_end'; id: string; name: string; success: boolean; error?: string }
  | { type: 'done'; messageId: string; tokensIn: number; tokensOut: number; costUsd: number }
  | { type: 'error'; message: string }

// ── Anthropic client ────────────────────────────────────────────────────────

const globalForAnthropic = globalThis as unknown as { anthropic: Anthropic | undefined }
function getClient(): Anthropic {
  if (!globalForAnthropic.anthropic) {
    globalForAnthropic.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  }
  return globalForAnthropic.anthropic
}

// ── Types ──────────────────────────────────────────────────────────────────

type ApiMessage = Anthropic.Messages.MessageParam

// Locally collected block after streaming (avoids SDK response/param mismatch).
type CollectedBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

// Stored in DB user messages to reference uploaded files.
interface FileRefBlock {
  type: 'file_ref'
  bucket: string
  path: string
  mediaType: string
}

type StoredContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | FileRefBlock

// ── History loading with file reconstruction ───────────────────────────────

async function resolveFileRef(ref: FileRefBlock): Promise<Anthropic.Messages.ContentBlockParam> {
  const buffer = await agentStorageDownload(ref.path)
  const b64 = buffer.toString('base64')
  if (ref.mediaType === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: b64 },
    } as unknown as Anthropic.Messages.ContentBlockParam
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: ref.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
      data: b64,
    },
  }
}

/**
 * Loads conversation history and converts to Anthropic MessageParam[].
 * File refs in user messages are resolved to base64 for the 5 most-recent
 * file-containing messages; older ones get a text placeholder instead.
 */
async function loadHistory(conversationId: string): Promise<ApiMessage[]> {
  const rows = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  })

  // Identify indices of user messages that contain file_ref blocks (most-recent first).
  const fileMessageIndices: number[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const content = rows[i].content as unknown as StoredContentBlock[]
    if (Array.isArray(content) && content.some((b) => b.type === 'file_ref')) {
      fileMessageIndices.push(i)
    }
  }
  const recentFileSet = new Set(fileMessageIndices.slice(0, 5))

  const result: ApiMessage[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const stored = row.content as unknown as StoredContentBlock[]

    if (!Array.isArray(stored)) {
      result.push({ role: row.role as 'user' | 'assistant', content: String(stored) })
      continue
    }

    const apiBlocks: Anthropic.Messages.ContentBlockParam[] = []
    for (const block of stored) {
      if (block.type === 'file_ref') {
        if (recentFileSet.has(i)) {
          try {
            apiBlocks.push(await resolveFileRef(block))
          } catch {
            apiBlocks.push({ type: 'text', text: '[ফাইল লোড করা যায়নি]' })
          }
        } else {
          apiBlocks.push({ type: 'text', text: '[পূর্ববর্তী ফাইল সংযুক্তি]' })
        }
      } else {
        apiBlocks.push(block as unknown as Anthropic.Messages.ContentBlockParam)
      }
    }

    result.push({ role: row.role as 'user' | 'assistant', content: apiBlocks })
  }

  return result
}

/** Marks the last user turn with cache_control for prompt caching. */
function applyCacheControl(messages: ApiMessage[]): ApiMessage[] {
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
    return [
      ...messages.slice(0, i),
      { role: 'user' as const, content: blocks },
      ...messages.slice(i + 1),
    ]
  }
  return messages
}

// ── Memory helpers ─────────────────────────────────────────────────────────

async function loadPinnedMemories(): Promise<PinnedMemory[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).agentMemory.findMany({
      where: { pinned: true },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, content: true, scope: true },
    })
    return rows as PinnedMemory[]
  } catch {
    return []
  }
}

const SIMILARITY_THRESHOLD = 0.45

async function retrieveRelevantMemories(userMessage: string): Promise<RelevantMemory[]> {
  try {
    const embedResult = await embed(userMessage)
    if (!embedResult.success) return []

    const vec = vectorLiteral(embedResult.data)
    const rows: Array<{ id: string; content: string; scope: string; score: number }> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).$queryRawUnsafe(
        `SELECT id, content, scope,
                1 - (embedding <=> $1::vector) AS score
         FROM agent_memory
         WHERE embedding IS NOT NULL AND pinned = false
         ORDER BY embedding <=> $1::vector
         LIMIT 3`,
        vec,
      )

    return rows
      .filter((r) => r.score >= SIMILARITY_THRESHOLD)
      .map((r) => ({ ...r, score: Math.round(r.score * 100) / 100 }))
  } catch {
    return []
  }
}

// ── Options ────────────────────────────────────────────────────────────────

export interface RunAgentTurnOptions {
  /** System instructions from the conversation's project (appended to base system prompt). */
  projectSystemInstructions?: string | null
  /** AbortSignal from the HTTP request — cancels the stream early if client disconnects. */
  signal?: AbortSignal
}

// ── Main agent turn ────────────────────────────────────────────────────────

export async function* runAgentTurn(
  conversationId: string,
  options: RunAgentTurnOptions = {},
): AsyncGenerator<AgentEvent> {
  const client = getClient()
  const { projectSystemInstructions, signal } = options

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheCreationTokens = 0
  let totalCacheReadTokens = 0

  let messages: ApiMessage[] = await loadHistory(conversationId)
  const assistantTurns: CollectedBlock[][] = []

  // Extract the text of the last user message for auto-retrieval
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  const lastUserText = lastUserMsg
    ? Array.isArray(lastUserMsg.content)
      ? lastUserMsg.content.filter((b): b is Anthropic.Messages.TextBlockParam => b.type === 'text').map((b) => b.text).join(' ')
      : String(lastUserMsg.content)
    : ''

  // Load pinned memories and retrieve relevant memories in parallel
  const [pinnedMemories, relevantMemories] = await Promise.all([
    loadPinnedMemories(),
    lastUserText ? retrieveRelevantMemories(lastUserText) : Promise.resolve([]),
  ])

  type ToolRecord = {
    id: string; toolName: string; input: Record<string, unknown>
    output: Record<string, unknown> | null; status: 'success' | 'error'
    durationMs: number; error: string | null
  }
  const toolRecords: ToolRecord[] = []

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (signal?.aborted) break

      const apiMessages = applyCacheControl(messages)

      const stream = client.messages.stream(
        {
          model: AGENT_MODEL,
          max_tokens: 8192,
          thinking: { type: 'adaptive' },
          system: buildSystemPrompt(projectSystemInstructions, pinnedMemories, relevantMemories),
          tools: TOOL_DEFINITIONS,
          messages: apiMessages,
        },
        { signal: signal ?? undefined },
      )

      const currentBlocks: CollectedBlock[] = []
      let activeBlockType: string | null = null
      let activeBlockText = ''
      let activeBlockId = ''
      let activeBlockName = ''
      let activeBlockInputJson = ''

      for await (const event of stream) {
        if (signal?.aborted) break

        if (event.type === 'message_start') {
          const u = event.message.usage
          totalInputTokens += u.input_tokens
          totalOutputTokens += u.output_tokens
          totalCacheCreationTokens += (u as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0
          totalCacheReadTokens += (u as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0
        } else if (event.type === 'message_delta') {
          if (event.usage) totalOutputTokens += event.usage.output_tokens
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
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            activeBlockText += delta.text
            yield { type: 'text_delta', delta: delta.text }
          } else if (delta.type === 'input_json_delta') {
            activeBlockInputJson += delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          if (activeBlockType === 'text') {
            currentBlocks.push({ type: 'text', text: activeBlockText })
          } else if (activeBlockType === 'tool_use') {
            let parsedInput: Record<string, unknown> = {}
            try { parsedInput = JSON.parse(activeBlockInputJson || '{}') } catch { parsedInput = { _raw: activeBlockInputJson } }
            currentBlocks.push({ type: 'tool_use', id: activeBlockId, name: activeBlockName, input: parsedInput })
          }
        }
      }

      assistantTurns.push(currentBlocks)

      const toolUseBlocks = currentBlocks.filter(
        (b): b is Extract<CollectedBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )

      if (toolUseBlocks.length === 0 || signal?.aborted) break

      messages = [
        ...messages,
        { role: 'assistant', content: currentBlocks as unknown as Anthropic.Messages.ContentBlockParam[] },
      ]

      const toolResultContent: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const tb of toolUseBlocks) {
        const started = Date.now()
        const result = await executeTool(tb.name, tb.input)
        const durationMs = Date.now() - started

        toolRecords.push({
          id: tb.id, toolName: tb.name, input: tb.input,
          output: result.data !== undefined ? { data: result.data } : null,
          status: result.success ? 'success' : 'error',
          durationMs, error: result.error ?? null,
        })

        yield { type: 'tool_end', id: tb.id, name: tb.name, success: result.success, error: result.error }

        toolResultContent.push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: JSON.stringify(result),
        })
      }

      messages = [...messages, { role: 'user', content: toolResultContent }]
    }

    // Persist assistant message.
    const textContent = assistantTurns.flat().filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    const storedContent = textContent.length > 0 ? textContent : [{ type: 'text', text: '' }]
    const costUsd = calcCostUsd({
      input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
      cache_creation_input_tokens: totalCacheCreationTokens, cache_read_input_tokens: totalCacheReadTokens,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const savedMsg = await db.agentMessage.create({
      data: {
        conversationId, role: 'assistant', content: storedContent,
        tokensIn: totalInputTokens, tokensOut: totalOutputTokens, costUsd,
        usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cache_creation_input_tokens: totalCacheCreationTokens, cache_read_input_tokens: totalCacheReadTokens },
      },
    })

    if (toolRecords.length > 0) {
      await db.agentToolCall.createMany({
        data: toolRecords.map((r: ToolRecord) => ({
          messageId: savedMsg.id, toolName: r.toolName, input: r.input,
          output: r.output, status: r.status, durationMs: r.durationMs, error: r.error,
        })),
      })
    }

    await prisma.agentConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })

    yield { type: 'done', messageId: savedMsg.id, tokensIn: totalInputTokens, tokensOut: totalOutputTokens, costUsd }
  } catch (err) {
    if (signal?.aborted) return
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}
