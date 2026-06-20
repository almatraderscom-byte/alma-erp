import { OpenAiAdapter } from '@/agent/lib/models/adapters/openai'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

export function createOpenRouterAdapter(): OpenAiAdapter {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) throw new Error('OPENROUTER_API_KEY not configured')
  const referer = process.env.APP_URL?.replace(/\/$/, '') ?? 'https://alma-erp-six.vercel.app'
  return new OpenAiAdapter(key, {
    baseURL: OPENROUTER_BASE,
    defaultHeaders: {
      'HTTP-Referer': referer,
      'X-Title': 'ALMA ERP Agent',
    },
    // Cache the stable system-prompt prefix across turns (Qwen/DeepSeek/Claude via
    // OpenRouter). Big cost lever when a model runs as the direct head.
    cachePrefix: true,
  })
}
