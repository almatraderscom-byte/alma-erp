/**
 * WhatsApp template message helper (utility/marketing templates registered in Meta).
 */
import { resilientFetch } from '../fetch-retry.mjs'
import { metaGraphBase } from '../meta-version.mjs'

const GRAPH = metaGraphBase()

function phoneNumberId(pageId) {
  return String(pageId ?? '').replace(/^wa:/, '')
}

/**
 * @param {object} input
 * @param {string} input.pageId - wa:PHONE_NUMBER_ID
 * @param {string} input.to - recipient wa_id
 * @param {string} input.templateName - approved template name in Meta
 * @param {string} [input.languageCode='en']
 * @param {unknown[]} [input.components]
 */
export async function sendWaTemplate(input) {
  const token = process.env.WA_TOKEN
  const pid = phoneNumberId(input.pageId)
  if (!token) throw new Error('WA_TOKEN not configured')
  if (!pid) throw new Error('missing WA phone number id')

  const res = await resilientFetch(`${GRAPH}/${pid}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: String(input.to).replace(/\D/g, ''),
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.languageCode ?? 'en' },
        components: input.components ?? [],
      },
    }),
    timeoutMs: 20_000,
    retries: 1,
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? `WA template HTTP ${res.status}`)
  return data
}

/** List templates for debugging (requires WA_WABA_ID). */
export async function listWaTemplates() {
  const token = process.env.WA_TOKEN
  const wabaId = process.env.WA_WABA_ID
  if (!token || !wabaId) return { templates: [], error: 'WA_TOKEN or WA_WABA_ID missing' }

  const res = await resilientFetch(`${GRAPH}/${wabaId}/message_templates?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
    retries: 1,
  })
  const data = await res.json()
  if (!res.ok) return { templates: [], error: data.error?.message ?? `HTTP ${res.status}` }
  return { templates: data.data ?? [] }
}
