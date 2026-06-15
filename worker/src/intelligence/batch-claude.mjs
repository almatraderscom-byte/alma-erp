/**
 * Anthropic Message Batches API helper — 50% token discount, async completion.
 * Pattern 1: submit + poll in-process (scheduled jobs, non-urgent).
 */
import Anthropic from '@anthropic-ai/sdk'

const DEFAULT_MODEL = 'claude-sonnet-4-6'

/**
 * @param {Array<{ custom_id: string, system?: string | Array<unknown>, messages: Array<{ role: string, content: string }>, max_tokens?: number }>} requests
 * @param {{ model?: string, pollMs?: number, maxWaitMs?: number }} [opts]
 * @returns {Promise<Map<string, { text?: string, usage?: object, error?: string }>>}
 */
export async function runBatch(requests, { model = DEFAULT_MODEL, pollMs = 20_000, maxWaitMs = 600_000 } = {}) {
  if (!requests?.length) return new Map()

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing')

  const client = new Anthropic({ apiKey })

  const batch = await client.messages.batches.create({
    requests: requests.map((r) => ({
      custom_id: r.custom_id,
      params: {
        model,
        max_tokens: r.max_tokens ?? 4096,
        ...(r.system != null ? { system: r.system } : {}),
        messages: r.messages,
      },
    })),
  })

  const start = Date.now()
  let status = batch
  while (status.processing_status !== 'ended') {
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`batch ${batch.id} timeout after ${maxWaitMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    status = await client.messages.batches.retrieve(batch.id)
  }

  const out = new Map()
  for await (const res of await client.messages.batches.results(batch.id)) {
    if (res.result.type === 'succeeded') {
      const text = res.result.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
      out.set(res.custom_id, { text, usage: res.result.message.usage })
    } else {
      out.set(res.custom_id, { error: res.result.type })
    }
  }

  return out
}
