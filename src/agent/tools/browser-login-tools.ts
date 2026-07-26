/**
 * Saved browser logins on the VPS — see them, and clear them.
 *
 * A persistent profile is what lets the owner log into a site once instead of
 * every time. The cost is disk that only ever grows, on a box that also runs the
 * phone system, so the owner needs a plain way to ask what is stored and to throw
 * it away. Automatic cleanup exists too (see worker/src/browser/profile-store.mjs),
 * but a cleanup he cannot trigger himself is a cleanup he cannot trust.
 */
import type { AgentTool } from './registry'
import { callLiveService, formatBytes } from '@/agent/lib/browser/live-client'

interface ProfileRow {
  key: string
  bytes: number
  lastUsedAt: string
}

const manage_browser_logins: AgentTool = {
  name: 'manage_browser_logins',
  description:
    'See or clear the logins the VPS browser has saved (per-site Chromium profiles), and how much disk they use. ' +
    'action="list" shows every saved site with its size. ' +
    'action="clear_cache" frees the bulk of a site\'s disk but KEEPS the login. ' +
    'action="clear_site" removes one site entirely — the owner WILL have to log in there again. ' +
    'action="clear_all" removes every saved login. ' +
    'action="enforce" applies the disk budget now (expired profiles out, caches trimmed, oldest evicted). ' +
    'Use this when the owner asks about browser cookies/logins or about disk on the VPS. ' +
    'Owner-facing, answer in Bangla. Before clear_site / clear_all, say plainly that the login will be lost.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'clear_cache', 'clear_site', 'clear_all', 'enforce'],
        description: 'What to do. Defaults to list.',
      },
      site: { type: 'string', description: 'Site/profile key — required for clear_site and clear_cache.' },
    },
    required: [],
  },
  handler: async (input) => {
    const action = String(input.action ?? 'list')
    const site = String(input.site ?? '').trim()

    if ((action === 'clear_site' || action === 'clear_cache') && !site) {
      return { success: false, error: 'site is required for that action' }
    }

    if (action === 'list') {
      const res = await callLiveService<{ profiles: ProfileRow[]; totalBytes: number }>('/profiles')
      if (!res.ok) return { success: false, error: res.error }
      const profiles = res.data?.profiles ?? []
      const total = res.data?.totalBytes ?? 0
      return {
        success: true,
        data: {
          profiles,
          totalBytes: total,
          message: profiles.length
            ? `VPS ব্রাউজারে ${profiles.length}টি সাইটের লগইন জমা আছে, মোট ${formatBytes(total)}:\n` +
              profiles
                .map((p) => `• ${p.key} — ${formatBytes(p.bytes)} (শেষ ব্যবহার ${p.lastUsedAt.slice(0, 10)})`)
                .join('\n')
            : 'VPS ব্রাউজারে এখনো কোনো সাইটের লগইন জমা নেই, Boss।',
        },
      }
    }

    if (action === 'enforce') {
      const res = await callLiveService<{ trimmedBytes: number; expired: string[]; evicted: string[]; totalBytes: number }>(
        '/profiles/enforce',
        { method: 'POST', timeoutMs: 60_000 },
      )
      if (!res.ok) return { success: false, error: res.error }
      const d = res.data
      return {
        success: true,
        data: {
          ...d,
          message:
            `ডিস্কের হিসাব মিলিয়ে নিলাম — এখন মোট ${formatBytes(d?.totalBytes ?? 0)}। ` +
            `ক্যাশ থেকে ${formatBytes(d?.trimmedBytes ?? 0)} খালি হয়েছে` +
            (d?.expired?.length ? `, মেয়াদোত্তীর্ণ বাদ: ${d.expired.join(', ')}` : '') +
            (d?.evicted?.length ? `, জায়গার জন্য বাদ: ${d.evicted.join(', ')}` : '') +
            '।',
        },
      }
    }

    const res = await callLiveService<{ freed: number; removed?: string[]; keptLogin?: boolean }>('/profiles/purge', {
      method: 'POST',
      body: action === 'clear_all' ? { all: true } : { key: site, cachesOnly: action === 'clear_cache' },
      timeoutMs: 60_000,
    })
    if (!res.ok) return { success: false, error: res.error }

    const freed = formatBytes(res.data?.freed ?? 0)
    const message =
      action === 'clear_all'
        ? `সব সাইটের জমানো লগইন মুছে দিলাম, Boss — ${freed} খালি হলো। এখন থেকে প্রতিটা সাইটে আবার লগইন করতে হবে।`
        : action === 'clear_cache'
          ? `${site}-এর ক্যাশ মুছলাম — ${freed} খালি হলো। লগইন ঠিকই আছে, আবার লগইন করতে হবে না।`
          : `${site}-এর জমানো লগইন মুছে দিলাম — ${freed} খালি হলো। ওই সাইটে পরেরবার আবার লগইন করতে হবে।`

    return { success: true, data: { ...res.data, message } }
  },
}

export const BROWSER_LOGIN_TOOLS: AgentTool[] = [manage_browser_logins]
