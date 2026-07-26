/**
 * Opening the VPS live browser from a conversation.
 *
 * Until now the only way to start a live session was the button on the web page,
 * which meant the owner could ask for it from his phone and the agent could only
 * describe where to click. This closes that: he asks, a browser opens, and he gets
 * a link that lands him on the live screen already running.
 *
 * The stream is sized for the device that will watch it. A phone on mobile data
 * costs the owner his own money and battery, so it gets ~0.6 Mbit/s instead of the
 * ~4.8 Mbit/s a laptop on wifi can take without noticing (measured, not guessed).
 */
import type { AgentTool } from './registry'
import { callLiveService, isLiveViewEnabled, LIVE_VIEW_ENABLED_KEY } from '@/agent/lib/browser/live-client'

/** Measured shapes — see worker/src/browser/live-session.mjs for why these numbers. */
const STREAM_PROFILES = {
  phone: { fps: 2, quality: 35, width: 720 },
  desktop: { fps: 5, quality: 50, width: 1280 },
} as const

interface LiveStatus {
  running: boolean
  sessionId?: string
  url?: string
  paused?: boolean
  pauseReason?: string | null
  profile?: string | null
}

function liveLink(): string {
  const base = (process.env.APP_URL ?? '').replace(/\/$/, '')
  return `${base}/agent/browser-live`
}

const open_live_browser: AgentTool = {
  name: 'open_live_browser',
  description:
    'Open the VPS browser so the owner can WATCH it live and take over when a page needs a human ' +
    '(a login, a captcha, a checkbox only he should tick). ' +
    'action="open" starts a session and returns the link to watch it; "close" stops it; "status" reports what it is doing. ' +
    'Use `on` to say where he will watch — "phone" sends a much lighter stream than "desktop". ' +
    'Use `profile` to reuse a saved login for a site (e.g. profile="ahrefs.com"). ' +
    'This is the VPS browser, NOT the owner\'s own Mac Chrome — those are different machines with different switches. ' +
    'If it is switched off, say so and tell him how to turn it on. Owner-facing, answer in Bangla, and always give him the link.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['open', 'close', 'status'], description: 'Defaults to open.' },
      startUrl: { type: 'string', description: 'Page to open first (http/https).' },
      on: { type: 'string', enum: ['phone', 'desktop'], description: 'Where the owner will watch. Defaults to phone.' },
      profile: { type: 'string', description: 'Saved-login profile key to reuse, e.g. "ahrefs.com". Omit for a clean anonymous session.' },
      goal: { type: 'string', description: 'One line on what this session is for (shown on the live screen).' },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const action = String(input.action ?? 'open')

      if (action === 'status') {
        const res = await callLiveService<LiveStatus>('/live/status')
        if (!res.ok) return { success: false, error: res.error }
        const s = res.data
        return {
          success: true,
          data: {
            ...s,
            link: liveLink(),
            message: s?.running
              ? `VPS ব্রাউজার চলছে${s.url ? ` — ${s.url}` : ''}${s.paused ? ' (এখন থেমে আছে)' : ''}। দেখতে: ${liveLink()}`
              : 'VPS ব্রাউজারে এখন কোনো সেশন চালু নেই, Boss।',
          },
        }
      }

      if (action === 'close') {
        const res = await callLiveService('/live/stop', { method: 'POST', timeoutMs: 20_000 })
        if (!res.ok) return { success: false, error: res.error }
        return { success: true, data: { message: 'VPS ব্রাউজার বন্ধ করে দিলাম, Boss।' } }
      }

      // open
      if (!(await isLiveViewEnabled())) {
        return {
          success: false,
          error: 'browser_live_disabled',
          data: {
            message:
              'VPS ব্রাউজার এখন বন্ধ আছে, Boss। চালু করতে বলুন — "VPS ব্রাউজার চালু করো" ' +
              `(settings: ${LIVE_VIEW_ENABLED_KEY} = true)। এটা আপনার Mac-এর Chrome নয়, সেটার সুইচ আলাদা।`,
          },
        }
      }

      const startUrl = String(input.startUrl ?? '').trim()
      if (startUrl && !/^https?:\/\//i.test(startUrl)) {
        return { success: false, error: 'startUrl must be an http(s) URL' }
      }
      const where = input.on === 'desktop' ? 'desktop' : 'phone'

      const res = await callLiveService<{ sessionId?: string; error?: string }>('/live/start', {
        method: 'POST',
        body: {
          startUrl: startUrl || undefined,
          goal: String(input.goal ?? 'owner live session'),
          profile: input.profile ? String(input.profile) : undefined,
          stream: STREAM_PROFILES[where],
        },
        timeoutMs: 60_000,
      })
      if (!res.ok) {
        // The commonest refusal is a call in progress, and that reason is worth
        // passing through verbatim — it tells him to wait, not to retry harder.
        return { success: false, error: res.error }
      }

      return {
        success: true,
        data: {
          sessionId: res.data?.sessionId,
          link: liveLink(),
          stream: STREAM_PROFILES[where],
          message:
            `VPS ব্রাউজার খুলেছি${startUrl ? ` — ${startUrl}` : ''}, Boss। ` +
            `লাইভ দেখতে: ${liveLink()} ` +
            (where === 'phone' ? '(ফোনের জন্য হালকা স্ট্রিম দিয়েছি)' : '') +
            ' লগইন বা ক্যাপচা এলে আপনি নিজে হাত দিয়ে পার করে দিলে বাকিটা আমি শেষ করব।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const BROWSER_LIVE_TOOLS: AgentTool[] = [open_live_browser]
