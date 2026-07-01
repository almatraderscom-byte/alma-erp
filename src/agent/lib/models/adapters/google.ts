import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai'
import type { NeutralMsg, NeutralTool, ProviderAdapter, TurnEvent } from '@/agent/lib/models/types'
import { sanitizeSchemaForGemini } from '@/agent/lib/models/adapters/gemini-schema'

function toGeminiContents(messages: NeutralMsg[]): Content[] {
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
      const parts: Part[] = msg.toolCalls.map((tc) => ({
        functionCall: { name: tc.name, args: tc.input },
      }))
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
    const genModel = this.client.getGenerativeModel({
      model: args.apiModel,
      systemInstruction: args.system,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: (args.tools.length
        ? [{
            functionDeclarations: args.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: sanitizeSchemaForGemini(t.schema),
            })),
          }]
        : undefined) as any,
    })

    const result = await genModel.generateContentStream({
      contents: toGeminiContents(args.messages),
    })

    for await (const chunk of result.stream) {
      if (args.signal?.aborted) break
      const parts = chunk.candidates?.[0]?.content?.parts ?? []
      for (const part of parts) {
        if (part.text) yield { type: 'text_delta', text: part.text }
        if (part.functionCall?.name) {
          const id = `gemini_${part.functionCall.name}_${Date.now()}`
          const input = (part.functionCall.args ?? {}) as Record<string, unknown>
          yield { type: 'tool_start', id, name: part.functionCall.name }
          yield { type: 'tool_input', id, input }
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
