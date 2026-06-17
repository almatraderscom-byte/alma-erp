/**
 * POST /api/assistant/internal/task-auto-qc
 * Vision QC for staff task proof — wraps runAutoQc (no scoring changes).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { runAutoQc, QC_THRESHOLD, SHADOW_MODE } from '@/agent/lib/auto-qc'

export const runtime = 'nodejs'
export const maxDuration = 30

const TRUSTED_IMAGE_HOSTS = new Set([
  'api.telegram.org',
  'scontent.xx.fbcdn.net',
  'lookaside.fbsbx.com',
  'platform-lookaside.fbsbx.com',
])

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const QC_TASK_TYPES = new Set([
  'ad_creative',
  'product_content',
  'product_photo',
  'video_reel',
  'organic_marketing',
])

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

function isTrustedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (TRUSTED_IMAGE_HOSTS.has(parsed.hostname)) return true
    if (parsed.hostname.endsWith('.fbcdn.net')) return true
    if (parsed.hostname.endsWith('.supabase.co')) return true
    if (parsed.hostname.endsWith('.cdninstagram.com')) return true
    return false
  } catch {
    return false
  }
}

async function fetchImageSafe(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  if (!isTrustedImageUrl(url)) return null
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_IMAGE_BYTES) return null
  const mime = res.headers.get('content-type')?.startsWith('image/')
    ? res.headers.get('content-type')!
    : 'image/jpeg'
  return { buf, mime }
}

function buildFixReason(score: number, issues: string[]): string {
  if (issues.length) return issues[0]
  return `QC score ${score}/100 — ${QC_THRESHOLD} এর উপরে দরকার। আলো/ব্যাকগ্রাউন্ড/ক্লিয়ার ছবি চেক করুন।`
}

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    taskType?: string
    taskTitle?: string
    proofImageUrl?: string
  }

  const taskType = body.taskType ?? ''
  if (!QC_TASK_TYPES.has(taskType)) {
    return NextResponse.json({ ran: false, skipped: true, reason: 'not_qc_type', shadowMode: SHADOW_MODE })
  }

  const url = typeof body.proofImageUrl === 'string' ? body.proofImageUrl.trim() : ''
  if (!url) {
    return NextResponse.json({ ran: false, skipped: true, reason: 'no_image', shadowMode: SHADOW_MODE })
  }

  const image = await fetchImageSafe(url)
  if (!image) {
    return NextResponse.json({ ran: false, skipped: true, reason: 'image_fetch_failed', shadowMode: SHADOW_MODE })
  }

  const qc = await runAutoQc(image.buf.toString('base64'), image.mime)
  if (!qc.ran) {
    return NextResponse.json({ ran: false, skipped: true, reason: 'qc_error', shadowMode: SHADOW_MODE })
  }

  const score = qc.score ?? 0
  const passed = score >= QC_THRESHOLD
  const issues = qc.issues ?? []

  return NextResponse.json({
    ran: true,
    score,
    passed,
    verdict: qc.verdict,
    issues,
    reason: passed ? '' : buildFixReason(score, issues),
    threshold: QC_THRESHOLD,
    shadowMode: SHADOW_MODE,
  })
}
