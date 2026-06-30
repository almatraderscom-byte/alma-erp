import { prisma } from '@/lib/prisma'

/**
 * Unified activity / audit timeline (read-only aggregation).
 *
 * Audit trails live in many ERP tables with different shapes. Rather than add a
 * new write-path on sensitive financial/attendance code, this NORMALISES the
 * existing ERP-side logs into one filterable "who did what, when, why" stream.
 *
 * Sources (ERP only — agent-owned tables like AgentAuditLog are off-limits to ERP
 * code and have their own timeline under /agent):
 *  - ApprovalRequest (approved/rejected — the richest "who decided what + why")
 *  - EmployeePaymentMethodAuditLog (payout method changes — money)
 *  - BusinessArchiveAuditLog (archive/restore of business data)
 *  - TradingTelegramAuditLog / TelegramOpsAuditLog (trading + ops telegram events)
 *  - TradingVolumeTargetAudit (volume-target edits)
 *
 * Every source is isolated in try/catch so one failing query never blanks the rest.
 */

export type AuditSource =
  | 'approval'
  | 'payment_method'
  | 'archive'
  | 'trading_telegram'
  | 'telegram_ops'
  | 'volume_target'

export type AuditEntry = {
  id: string
  at: string
  source: AuditSource
  action: string
  actor: string
  resource: string
  detail?: string
  businessId?: string | null
}

const PER_SOURCE = 50
const TOTAL = 120

function clip(s: string | null | undefined, n = 160): string | undefined {
  if (!s) return undefined
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t || undefined
}

export async function buildAuditTimeline(): Promise<{ entries: AuditEntry[]; sources: Record<AuditSource, number> }> {
  const [approvals, payMethods, archives, tradingTg, opsTg, volTargets] = await Promise.all([
    prisma.approvalRequest.findMany({
      where: { status: { in: ['APPROVED', 'REJECTED'] as never } },
      select: { id: true, type: true, module: true, businessId: true, status: true, reason: true, approvedBy: true, rejectedBy: true, approvedAt: true, rejectedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: PER_SOURCE,
    }).catch(() => []),
    prisma.employeePaymentMethodAuditLog.findMany({
      select: { id: true, userId: true, businessId: true, actorUserId: true, action: true, detailJson: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: PER_SOURCE,
    }).catch(() => []),
    prisma.businessArchiveAuditLog.findMany({
      select: { id: true, businessId: true, action: true, actorUserId: true, detailJson: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: PER_SOURCE,
    }).catch(() => []),
    prisma.tradingTelegramAuditLog.findMany({
      select: { id: true, businessId: true, eventType: true, telegramUsername: true, detail: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: PER_SOURCE,
    }).catch(() => []),
    prisma.telegramOpsAuditLog.findMany({
      select: { id: true, businessId: true, eventType: true, actorUserId: true, employeeId: true, detail: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: PER_SOURCE,
    }).catch(() => []),
    prisma.tradingVolumeTargetAudit.findMany({
      select: { id: true, businessId: true, action: true, actorUserId: true, detail: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: PER_SOURCE,
    }).catch(() => []),
  ])

  // Resolve actor user-ids → display names in one round-trip.
  const ids = new Set<string>()
  for (const a of approvals) { if (a.approvedBy) ids.add(a.approvedBy); if (a.rejectedBy) ids.add(a.rejectedBy) }
  for (const p of payMethods) { ids.add(p.actorUserId); ids.add(p.userId) }
  for (const a of archives) ids.add(a.actorUserId)
  for (const o of opsTg) { if (o.actorUserId) ids.add(o.actorUserId) }
  for (const v of volTargets) { if (v.actorUserId) ids.add(v.actorUserId) }
  const users = ids.size
    ? await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, email: true } }).catch(() => [])
    : []
  const nameOf = new Map(users.map(u => [u.id, u.name || u.email || u.id.slice(0, 6)]))
  const who = (id?: string | null) => (id ? (nameOf.get(id) ?? id.slice(0, 6)) : 'System')

  const entries: AuditEntry[] = []

  for (const a of approvals) {
    const approved = a.status === 'APPROVED'
    entries.push({
      id: `ap_${a.id}`,
      at: (a.approvedAt ?? a.rejectedAt ?? a.createdAt).toISOString(),
      source: 'approval',
      action: approved ? 'অনুমোদন করেছেন' : 'বাতিল করেছেন',
      actor: who(approved ? a.approvedBy : a.rejectedBy),
      resource: `${a.module} · ${a.type}`,
      detail: clip(a.reason),
      businessId: a.businessId,
    })
  }
  for (const p of payMethods) {
    entries.push({
      id: `pm_${p.id}`, at: p.createdAt.toISOString(), source: 'payment_method',
      action: p.action, actor: who(p.actorUserId),
      resource: `পেমেন্ট মেথড · ${who(p.userId)}`, detail: clip(p.detailJson), businessId: p.businessId,
    })
  }
  for (const a of archives) {
    entries.push({
      id: `ar_${a.id}`, at: a.createdAt.toISOString(), source: 'archive',
      action: a.action, actor: who(a.actorUserId), resource: 'বিজনেস আর্কাইভ', detail: clip(a.detailJson), businessId: a.businessId,
    })
  }
  for (const t of tradingTg) {
    entries.push({
      id: `tt_${t.id}`, at: t.createdAt.toISOString(), source: 'trading_telegram',
      action: t.eventType, actor: t.telegramUsername || 'Telegram', resource: 'ট্রেডিং টেলিগ্রাম', detail: clip(t.detail), businessId: t.businessId,
    })
  }
  for (const o of opsTg) {
    entries.push({
      id: `to_${o.id}`, at: o.createdAt.toISOString(), source: 'telegram_ops',
      action: o.eventType, actor: who(o.actorUserId), resource: o.employeeId ? `কর্মী · ${o.employeeId}` : 'অপস', detail: clip(o.detail), businessId: o.businessId,
    })
  }
  for (const v of volTargets) {
    entries.push({
      id: `vt_${v.id}`, at: v.createdAt.toISOString(), source: 'volume_target',
      action: v.action, actor: who(v.actorUserId), resource: 'ভলিউম টার্গেট', detail: clip(v.detail), businessId: v.businessId,
    })
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const top = entries.slice(0, TOTAL)

  const sources = { approval: 0, payment_method: 0, archive: 0, trading_telegram: 0, telegram_ops: 0, volume_target: 0 } as Record<AuditSource, number>
  for (const e of top) sources[e.source]++

  return { entries: top, sources }
}
