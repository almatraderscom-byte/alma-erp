import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai'
import type { NeutralMsg, NeutralTool, ProviderAdapter, TurnEvent } from '@/agent/lib/models/types'
import { sanitizeSchemaForGemini } from '@/agent/lib/models/adapters/gemini-schema'

export function toGeminiContents(messages: NeutralMsg[]): Content[] {
  const out: Content[] = []

  for (const msg of messages) {
    if ('content' in msg && typeof msg.content === 'string') {
      out.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      })
      continue
    }

    if ('toolCalls' in msg) {
      // Gemini 3.x is a THINKING model: every functionCall it returns carries an
      // encrypted `thoughtSignature`. When we send the tool results back for the
      // NEXT round, that signature MUST be echoed on the same functionCall part —
      // omit it and the API 400s the follow-up request ("function call ... must be
      // accompanied by a thought signature"), which was silently kicking the head
      // to the DeepSeek fallback whenever Gemini engaged thinking before a tool
      // call. Re-attach it exactly as received, per part. `thoughtSignature` is
      // untyped in the pinned SDK (0.24.x) but forwarded verbatim, so cast loosely.
      const parts: Part[] = msg.toolCalls.map((tc) => {
        const part: Record<string, unknown> = { functionCall: { name: tc.name, args: tc.input } }
        if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature
        return part as unknown as Part
      })
      if (parts.length > 0) out.push({ role: 'model', parts })
      continue
    }

    if (msg.role === 'tool') {
      // Vision: if a tool (live browser) returned a screenshot, hand Gemini a REAL
      // inline image so it SEES the page — the same way the native Claude path
      // attaches an image block. Left as JSON, the base64 is undecodable to the
      // model AND bloats context ~100KB/shot, so strip it from the functionResponse
      // text and carry it only as an inlineData part alongside the response.
      const img =
        msg.result && typeof msg.result === 'object' && 'image' in msg.result
          ? (msg.result as { image?: { data?: unknown; mediaType?: unknown } }).image
          : undefined
      const imgData = img && typeof img.data === 'string' ? img.data : ''
      const imgMime = img && typeof img.mediaType === 'string' ? img.mediaType : 'image/jpeg'

      let responsePayload: unknown = msg.result
      if (imgData) {
        const { image: _omitImg, ...rest } = msg.result as Record<string, unknown>
        responsePayload = rest
      }

      const parts: Part[] = [{
        functionResponse: {
          name: msg.name,
          response: { result: responsePayload },
        },
      }]
      if (imgData) parts.push({ inlineData: { mimeType: imgMime, data: imgData } })

      out.push({ role: 'user', parts })
    }
  }

  return out
}

export class GoogleAdapter implements ProviderAdapter {
  private client: GoogleGenerativeAI

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  async *streamTurn(args: {
    apiModel: string
    system: string
    messages: NeutralMsg[]
    tools: NeutralTool[]
    signal?: AbortSignal
    thinking?: 'adaptive' | 'level' | 'none'
  }): AsyncGenerator<TurnEvent> {
    // Gemini 3.x Pro is a THINKING model: left to its defaults it reasons
    // SILENTLY (no streamed parts) for ~10s before emitting the first answer
    // token, so the owner stares at a frozen spinner the whole time. Asking the
    // API to `includeThoughts` makes it stream thought-summary parts, which we
    // surface below as `thinking_delta` — the SAME live "ভাবছি…" progress the
    // native Claude/DeepSeek heads already produce. Gated on `thinking !== 'none'`
    // so a caller can still opt a turn out. Nested under `generationConfig` per
    // the v1beta contract; typed loosely because the pinned SDK (0.24.x) predates
    // the thinkingConfig type but forwards unknown generationConfig keys verbatim.
    const wantThoughts = args.thinking !== 'none'
    const functionDeclarations = args.tools.length
      ? args.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeSchemaForGemini(t.schema),
        }))
      : undefined

    // Build the streaming call with an optional `includeThoughts`. Returned as a
    // thunk so we can retry WITHOUT thoughts if the preview model rejects the key.
    const open = (withThoughts: boolean) => {
      const genModel = this.client.getGenerativeModel({
        model: args.apiModel,
        systemInstruction: args.system,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generationConfig: (withThoughts
          ? { thinkingConfig: { includeThoughts: true } }
          : undefined) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: (functionDeclarations ? [{ functionDeclarations }] : undefined) as any,
      })
      return genModel.generateContentStream({ contents: toGeminiContents(args.messages) })
    }

    // SAFETY: `includeThoughts` is untyped in the pinned SDK and this is a preview
    // model — if the API 400s on it, retrying WITHOUT it must still answer, so the
    // thinking-stream upgrade can never take the live head down. We only retry when
    // nothing has been emitted yet (a mid-stream failure can't be safely restarted).
    let result: Awaited<ReturnType<typeof open>>
    try {
      result = await open(wantThoughts)
    } catch (err) {
      if (!wantThoughts) throw err
      console.warn('[google] includeThoughts rejected at open → retrying without it:', err instanceof Error ? err.message : err)
      result = await open(false)
    }

    let emittedAny = false
    try {
      for await (const chunk of result.stream) {
        if (args.signal?.aborted) break
        const parts = chunk.candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          if (part.text) {
            // Thought-summary parts carry `thought: true` (untyped in SDK 0.24.x).
            // Route them to the live thinking stream so they DON'T pollute the
            // final answer text, and the UI shows them as "ভাবছি…" progress.
            const isThought = (part as { thought?: boolean }).thought === true
            emittedAny = true
            yield isThought
              ? { type: 'thinking_delta', text: part.text }
              : { type: 'text_delta', text: part.text }
          }
          if (part.functionCall?.name) {
            const id = `gemini_${part.functionCall.name}_${Date.now()}`
            const input = (part.functionCall.args ?? {}) as Record<string, unknown>
            const thoughtSignature = (part as { thoughtSignature?: string }).thoughtSignature
            emittedAny = true
            yield { type: 'tool_start', id, name: part.functionCall.name }
            yield { type: 'tool_input', id, input, thoughtSignature }
          }
        }
      }
    } catch (err) {
      // Mid-stream failure with thoughts on and nothing emitted yet: retry clean.
      if (!wantThoughts || emittedAny) throw err
      console.warn('[google] stream failed with includeThoughts before output → retrying without it:', err instanceof Error ? err.message : err)
      result = await open(false)
      for await (const chunk of result.stream) {
        if (args.signal?.aborted) break
        const parts = chunk.candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          if (part.text) yield { type: 'text_delta', text: part.text }
          if (part.functionCall?.name) {
            const id = `gemini_${part.functionCall.name}_${Date.now()}`
            const input = (part.functionCall.args ?? {}) as Record<string, unknown>
            const thoughtSignature = (part as { thoughtSignature?: string }).thoughtSignature
            yield { type: 'tool_start', id, name: part.functionCall.name }
            yield { type: 'tool_input', id, input, thoughtSignature }
          }
        }
      }
    }

    const response = await result.response
    const meta = response.usageMetadata
    yield {
      type: 'usage',
      inputTokens: meta?.promptTokenCount ?? 0,
      outputTokens: meta?.candidatesTokenCount ?? 0,
    }
    yield { type: 'done' }
  }
}

export function createGoogleAdapter(): GoogleAdapter {
  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) throw new Error('GEMINI_API_KEY not configured')
  return new GoogleAdapter(key)
}
