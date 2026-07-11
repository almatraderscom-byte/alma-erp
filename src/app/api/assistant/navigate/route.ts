import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 20

import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { normalizeAlmaRole, filterNavByRole } from '@/lib/roles'
import { getNavForBusiness, resolveBusinessId } from '@/lib/businesses'
import { geminiGenerateText } from '@/agent/lib/gemini-text'

/**
 * POST /api/assistant/navigate — the staff navigator brain (Gemini Flash, cheap).
 *
 * Available to EVERY authenticated staff member (not owner-only). Given the user's
 * message + their role + current page, it decides whether to NAVIGATE (only to a
 * page that role is actually allowed to open — validated server-side against
 * filterNavByRole, so it can never send someone where they can't go) or to ANSWER
 * briefly. Read-only: this step never mutates anything (actions come in phase 2).
 */

// Compact bilingual hints so Flash maps "অর্ডার" → /orders reliably and cheaply.
const HINTS: Record<string, string> = {
  '/': 'হোম ড্যাশবোর্ড dashboard',
  '/digital': 'হোম ড্যাশবোর্ড dashboard',
  '/briefing': 'ব্রিফিং সকাল briefing',
  '/insights': 'ইনসাইট বিশ্লেষণ insights',
  '/activity': 'কার্যকলাপ লগ activity audit',
  '/approvals': 'অনুমোদন approve approvals',
  '/orders': 'অর্ডার order',
  '/crm': 'কাস্টমার গ্রাহক crm customer',
  '/inventory': 'স্টক প্রোডাক্ট inventory stock',
  '/invoice': 'ইনভয়েস বিল invoice',
  '/finance': 'ফিনান্স হিসাব টাকা finance',
  '/expenses': 'খরচ expense',
  '/employees': 'কর্মী employee staff',
  '/attendance': 'হাজিরা উপস্থিতি attendance',
  '/payroll': 'বেতন salary payroll wallet ওয়ালেট',
  '/analytics': 'অ্যানালিটিক্স রিপোর্ট analytics report',
  '/trading': 'ট্রেডিং trading',
  '/portal': 'আমার ডেস্ক my desk portal',
}

type NavResult = { navigate?: string; reply: string }

function parseModelJson(raw: string): { navigate?: string; say?: string; answer?: string } | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: { query?: unknown; currentPath?: unknown; businessId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 500) : ''
  if (!query) return Response.json({ error: 'empty_query' }, { status: 400 })
  const currentPath = typeof body.currentPath === 'string' ? body.currentPath : '/'

  const role = normalizeAlmaRole(token.role as string)
  const businessId = resolveBusinessId(typeof body.businessId === 'string' ? body.businessId : null)

  // Authoritative allow-list: exactly the pages this role can open.
  const allowed = filterNavByRole(getNavForBusiness(businessId), role, businessId)
  const allowedHrefs = new Set(allowed.map((n) => n.href))
  const routeLines = allowed.map((n) => `- ${n.href} : ${n.label}${HINTS[n.href] ? ` (${HINTS[n.href]})` : ''}`).join('\n')

  const prompt =
    `তুমি ALMA ERP অ্যাপের একজন সহায়ক নেভিগেটর। কর্মীর role: ${role}. তারা এখন এই পেজে আছে: ${currentPath}.\n` +
    `কর্মী বলেছে: "${query}"\n\n` +
    `তারা শুধু এই পেজগুলোতে যেতে পারে:\n${routeLines}\n\n` +
    `নিয়ম:\n` +
    `- কর্মী কোথাও যেতে চাইলে উপরের লিস্ট থেকে সঠিক href দাও।\n` +
    `- "নতুন অর্ডার / অর্ডার নাও" চাইলে এবং /orders লিস্টে থাকলে: {"navigate":"/orders?new=1","say":"নতুন অর্ডার ফর্ম খুলছি"}\n` +
    `- কিছু খুঁজতে চাইলে (কাস্টমার/অর্ডার/প্রোডাক্ট) সংশ্লিষ্ট পেজে ?q= দিয়ে পাঠাও — যেমন {"navigate":"/orders?q=রহিম","say":"খুঁজছি"} বা {"navigate":"/crm?q=017xxxxxxxx"} বা {"navigate":"/inventory?q=শাড়ি"} — কিন্তু শুধু যদি সেই পেজ লিস্টে থাকে।\n` +
    `- টাকা / delete / approve / status-change এই ধাপে নিজে কোরো না — সংশ্লিষ্ট পেজে পাঠাও।\n` +
    `- সাধারণ প্রশ্ন হলে ১ লাইনে বাংলায় উত্তর দাও।\n` +
    `- উত্তর শুধু JSON, কোনো ব্যাখ্যা/markdown নয়। হয়:\n` +
    `{"navigate":"/orders","say":"অর্ডার পেজে নিয়ে যাচ্ছি"}\n` +
    `অথবা: {"answer":"..."}\n` +
    `navigate-এর base path (? এর আগের অংশ) অবশ্যই উপরের লিস্টে থাকতে হবে।`

  let parsed: ReturnType<typeof parseModelJson> = null
  try {
    const raw = await geminiGenerateText({ prompt, costLabel: 'staff_navigate', maxTokens: 200, temperature: 0.2 })
    parsed = parseModelJson(raw)
  } catch (err) {
    console.warn('[navigate] model failed:', err instanceof Error ? err.message : err)
  }

  if (!parsed) {
    return Response.json({ reply: 'বুঝতে পারিনি, Boss — আবার একটু সহজ করে বলবেন?' } satisfies NavResult)
  }

  // Validate navigation against the role's allow-list — never trust the model
  // blindly. Allow a query string (?new=1 / ?q=…) but validate the BASE path, so a
  // staffer can still only be routed to a page their role can open.
  if (parsed.navigate) {
    const basePath = parsed.navigate.split('?')[0]
    if (allowedHrefs.has(basePath)) {
      return Response.json({ navigate: parsed.navigate, reply: parsed.say || 'নিয়ে যাচ্ছি…' } satisfies NavResult)
    }
  }
  const answer = parsed.answer || parsed.say
  if (answer) return Response.json({ reply: answer } satisfies NavResult)

  return Response.json({ reply: 'এই পেজে আপনার অ্যাকসেস নেই বা বুঝতে পারিনি।' } satisfies NavResult)
}
