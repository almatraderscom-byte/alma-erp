import { createHash } from 'crypto'
import OpenAI from 'openai'
import { calcEmbeddingCostUsd, estimateTokens } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'

const globalForOpenAI = globalThis as unknown as { openaiEmbeddings: OpenAI | undefined }

function getClient(): OpenAI {
  if (!globalForOpenAI.openaiEmbeddings) {
    globalForOpenAI.openaiEmbeddings = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? '',
    })
  }
  return globalForOpenAI.openaiEmbeddings
}

export type EmbedResult =
  | { success: true; data: number[] }
  | { success: false; error: string }

/** Embeds text using OpenAI text-embedding-3-small (1536 dims). */
export async function embed(text: string): Promise<EmbedResult> {
  if (!process.env.OPENAI_API_KEY) {
    return { success: false, error: 'OPENAI_API_KEY not configured' }
  }
  try {
    const client = getClient()
    const inputText = text.slice(0, 8000)
    const res = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: inputText,
    })
    const tokens = res.usage?.total_tokens ?? estimateTokens(inputText)
    const costUsd = calcEmbeddingCostUsd(tokens)
    void logCost({
      provider: 'openai',
      kind: 'embedding',
      units: { tokens, model: 'text-embedding-3-small' },
      costUsd,
      dedupKey: `embed:${createHash('sha256').update(inputText).digest('hex').slice(0, 16)}`,
    })
    return { success: true, data: res.data[0].embedding }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Formats a float[] as a pgvector literal: '[0.1,0.2,...]' */
export function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}
