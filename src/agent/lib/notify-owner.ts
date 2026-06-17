/**
 * Owner notifications from Vercel (watchdog, quota alerts).
 * Sends ntfy + logs to agent_notifications.
 */
import { resilientFetch } from '@/agent/lib/fetch-retry'

async function sendNtfy(topic: 'general' | 'critical', title: string, message: string, category?: string) {
  const server = (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, '')
  const topicName = topic === 'critical'
    ? (process.env.NTFY_TOPIC_CRITICAL ?? 'alma-agent-crit')
    : (process.env.NTFY_TOPIC_GENERAL ?? 'alma-agent')
  const priority = topic === 'critical' ? '5' : '3'
  const tags = category === 'urgent' ? 'rotating_light,sos' : category === 'salah' ? 'salah,mosque' : ''

  const res = await resilientFetch(`${server}/${topicName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: title,
      Priority: priority,
      ...(tags ? { Tags: tags } : {}),
    },
    body: message,
    timeoutMs: 15_000,
    retries: 1,
  })
  if (!res.ok) throw new Error(`ntfy ${topic} returned ${res.status}`)
}

/** Push to a staff member's personal ntfy topic (e.g. alma-staff-eyafi). */
export async function sendStaffNtfy(topic: string, title: string, message: string, category?: string) {
  const server = (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, '')
  const asciiTitle = String(title).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim() || 'ALMA'
  const tags = category === 'urgent' ? 'rotating_light,sos' : category === 'task' ? 'white_check_mark' : ''

  const res = await resilientFetch(`${server}/${topic}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: asciiTitle,
      Priority: category === 'urgent' ? '5' : '4',
      ...(tags ? { Tags: tags } : {}),
    },
    body: message,
    timeoutMs: 15_000,
    retries: 1,
  })
  if (!res.ok) throw new Error(`ntfy staff topic ${topic} returned ${res.status}`)
}

export async function notifyOwner(opts: {
  tier: 1 | 2 | 3
  title: string
  message: string
  category?: 'salah' | 'urgent' | 'task' | 'report'
}) {
  const channels: string[] = ['ntfy_general']
  const statuses: Record<string, string> = {}

  try {
    await sendNtfy('general', opts.title, opts.message, opts.category)
    statuses.ntfy_general = 'sent'
  } catch (err) {
    statuses.ntfy_general = `error: ${err instanceof Error ? err.message : String(err)}`
  }

  if (opts.tier >= 2) {
    channels.push('ntfy_critical')
    try {
      await sendNtfy('critical', opts.title, opts.message, opts.category)
      statuses.ntfy_critical = 'sent'
    } catch (err) {
      statuses.ntfy_critical = `error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const appUrl = (process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '')
  const internal = process.env.AGENT_INTERNAL_TOKEN
  if (appUrl && internal) {
    await resilientFetch(`${appUrl}/api/assistant/internal/notification-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${internal}`,
      },
      body: JSON.stringify({
        tier: opts.tier,
        category: opts.category ?? null,
        title: opts.title,
        message: opts.message,
        channels,
        statuses,
      }),
      timeoutMs: 15_000,
      retries: 1,
    }).catch((err) => {
      console.warn('[notify-owner] notification-log write failed:', err instanceof Error ? err.message : String(err))
    })
  }

  return { channels, statuses }
}
