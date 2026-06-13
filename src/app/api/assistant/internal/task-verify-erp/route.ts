/**
 * POST /api/assistant/internal/task-verify-erp
 * Best-effort ERP checks for listing_update / order_followup auto-verification.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { listInventoryMovements } from '@/lib/agent-api/services/inventory.service'
import { listAgentOrders } from '@/lib/agent-api/orders.service'
import { extractProductRef } from '@/agent/lib/task-verification'

export const runtime = 'nodejs'

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

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

function sinceCutoff(sinceIso?: string): Date {
  if (sinceIso) return new Date(sinceIso)
  return new Date(Date.now() - TWO_HOURS_MS)
}

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    action?: 'listing' | 'order'
    task?: { type?: string; title?: string; productRef?: string | null; detail?: string | null }
    sinceIso?: string
  }

  const since = sinceCutoff(body.sinceIso)
  const task = body.task ?? {}

  try {
    if (body.action === 'listing' || task.type === 'listing_update') {
      const ref = extractProductRef(task)
      if (!ref) {
        return NextResponse.json({ verified: false, evidence: 'প্রোডাক্ট রেফ পাওয়া যায়নি', method: 'manual' })
      }
      const { movements } = await listInventoryMovements({ sku: ref, limit: 30 })
      const recent = movements.filter((m) => {
        const at = new Date(String(m.timestamp ?? m.created_at ?? m.date ?? 0))
        return at >= since
      })
      if (recent.length > 0) {
        const at = new Date(String(recent[0].timestamp ?? recent[0].created_at ?? Date.now()))
        const time = at.toLocaleTimeString('bn-BD', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit' })
        return NextResponse.json({
          verified: true,
          evidence: `ERP-তে ${ref} আপডেট পাওয়া গেছে (${time})`,
          method: 'auto_erp',
        })
      }
      return NextResponse.json({ verified: false, evidence: 'ERP-তে সাম্প্রতিক আপডেট নেই', method: 'manual' })
    }

    if (body.action === 'order' || task.type === 'order_followup') {
      const { orders } = await listAgentOrders({ limit: 80 })
      const detail = String(task.detail ?? task.title ?? '').toLowerCase()
      const recent = orders.filter((o) => {
        const placed = new Date(o.placedAt)
        if (placed < since) return false
        const hay = `${o.orderNumber ?? ''} ${o.customerName ?? ''} ${o.customerPhone ?? ''}`.toLowerCase()
        if (!detail) return true
        return detail.split(/\s+/).some((tok) => tok.length > 3 && hay.includes(tok))
      })
      if (recent.length > 0) {
        const o = recent[0]
        return NextResponse.json({
          verified: true,
          evidence: `অর্ডার ${o.orderNumber ?? o.id} আপডেট/ফলোআপ পাওয়া গেছে`,
          method: 'auto_erp',
        })
      }
      return NextResponse.json({ verified: false, evidence: 'সাম্প্রতিক অর্ডার আপডেট পাওয়া যায়নি', method: 'manual' })
    }

    return NextResponse.json({ verified: false, evidence: 'অজানা টাস্ক টাইপ', method: 'manual' })
  } catch (err) {
    return NextResponse.json({
      verified: false,
      evidence: err instanceof Error ? err.message : 'ERP চেক ব্যর্থ',
      method: 'manual',
    })
  }
}
