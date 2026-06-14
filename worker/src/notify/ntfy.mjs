/**
 * ntfy push notification sender.
 * Docs: https://docs.ntfy.sh/publish/
 *
 * Categories map to ntfy tags for Android/iOS filtering:
 *   salah  → azan sound (configured per-topic in ntfy app)
 *   urgent → alarm sound
 *   task   → tada sound
 *   report → (default)
 */

const CATEGORY_TAGS = {
  salah:  ['salah', 'mosque'],
  urgent: ['rotating_light', 'sos'],
  task:   ['white_check_mark'],
  report: ['bar_chart'],
}

/** fetch() header values must be latin-1 — emoji/Bangla in Title breaks ntfy delivery. */
function ntfyTitleHeader(title) {
  const ascii = String(title).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim()
  return ascii || 'ALMA Agent'
}

/**
 * @param {'general'|'critical'} topic
 * @param {string} title
 * @param {string} message
 * @param {string|undefined} category
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function sendNtfy(topic, title, message, category) {
  const server = (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, '')
  const topicName = topic === 'critical'
    ? (process.env.NTFY_TOPIC_CRITICAL ?? 'alma-agent-crit')
    : (process.env.NTFY_TOPIC_GENERAL  ?? 'alma-agent')

  const priority = topic === 'critical' ? '5' : '3'
  const tags = CATEGORY_TAGS[category ?? ''] ?? []

  try {
    const res = await fetch(`${server}/${topicName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Title': ntfyTitleHeader(title),
        'Priority': priority,
        ...(tags.length > 0 ? { 'Tags': tags.join(',') } : {}),
      },
      body: message,
    })
    if (!res.ok) {
      const body = await res.text()
      return { ok: false, error: `ntfy HTTP ${res.status}: ${body}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Send to a specific named topic (e.g. a staff member's topic).
 * @param {string} topicName
 * @param {string} title
 * @param {string} message
 * @param {string|undefined} category
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function sendNtfyToTopic(topicName, title, message, category) {
  const server = (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, '')
  const tags = CATEGORY_TAGS[category ?? ''] ?? []
  try {
    const res = await fetch(`${server}/${topicName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Title': ntfyTitleHeader(title),
        'Priority': category === 'urgent' ? '5' : '4',
        ...(tags.length > 0 ? { 'Tags': tags.join(',') } : {}),
      },
      body: message,
    })
    if (!res.ok) {
      const body = await res.text()
      return { ok: false, error: `ntfy HTTP ${res.status}: ${body}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
