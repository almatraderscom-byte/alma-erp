import { prisma } from '@/lib/prisma'
import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'
import { serverGet } from '@/lib/server-api'
import type { BusinessId } from '@/lib/businesses'
import { BUSINESSES } from '@/lib/businesses'

export type ArchiveModuleDef = {
  key: string
  label: string
  description: string
  /** Prisma-backed archive (indexed isArchived) vs registry-only (GAS/external). */
  storage: 'prisma' | 'registry'
  businesses: BusinessId[] | 'ALL'
}

export const ARCHIVE_MODULES: ArchiveModuleDef[] = [
  { key: 'approvals', label: 'Approvals', description: 'Approval requests', storage: 'prisma', businesses: 'ALL' },
  { key: 'attendance', label: 'Attendance', description: 'Attendance records', storage: 'prisma', businesses: 'ALL' },
  { key: 'attendance_waivers', label: 'Attendance waivers', description: 'Penalty waiver requests', storage: 'prisma', businesses: 'ALL' },
  { key: 'wallet_requests', label: 'Payroll wallet', description: 'Wallet withdrawal/advance requests', storage: 'prisma', businesses: 'ALL' },
  { key: 'expenses', label: 'Expenses', description: 'Employee ledger expense entries', storage: 'prisma', businesses: 'ALL' },
  { key: 'invoices', label: 'Invoices', description: 'Invoice records', storage: 'prisma', businesses: 'ALL' },
  { key: 'trading_trades', label: 'Trading trades', description: 'Trading trade ledger', storage: 'prisma', businesses: ['ALMA_TRADING'] },
  { key: 'trading_expenses', label: 'Trading expenses', description: 'Trading account expenses', storage: 'prisma', businesses: ['ALMA_TRADING'] },
  { key: 'telegram_drafts', label: 'Telegram drafts', description: 'Telegram trade drafts', storage: 'prisma', businesses: ['ALMA_TRADING'] },
  { key: 'orders', label: 'Orders', description: 'Order workspace (registry — GAS)', storage: 'registry', businesses: ['ALMA_LIFESTYLE', 'CREATIVE_DIGITAL_IT'] },
  { key: 'inventory', label: 'Inventory', description: 'Stock/inventory (registry — GAS)', storage: 'registry', businesses: ['ALMA_LIFESTYLE'] },
  { key: 'crm', label: 'CRM', description: 'CRM customers (registry — GAS)', storage: 'registry', businesses: ['ALMA_LIFESTYLE'] },
]

export function modulesForBusiness(businessId: string): ArchiveModuleDef[] {
  return ARCHIVE_MODULES.filter(
    m => m.businesses === 'ALL' || (m.businesses as BusinessId[]).includes(businessId as BusinessId),
  )
}

export function resolveModule(key: string) {
  return ARCHIVE_MODULES.find(m => m.key === key) ?? null
}

type PreviewRow = {
  moduleKey: string
  label: string
  count: number
  oldestAt: string | null
  newestAt: string | null
  storage: string
}

async function aggregateDates(rows: { createdAt?: Date; tradeDate?: Date; attendanceDate?: Date; expenseDate?: Date }[]) {
  if (!rows.length) return { oldest: null as string | null, newest: null as string | null }
  const times = rows
    .map(r => (r.createdAt || r.tradeDate || r.attendanceDate || r.expenseDate)?.getTime())
    .filter((t): t is number => typeof t === 'number')
  if (!times.length) return { oldest: null, newest: null }
  return {
    oldest: new Date(Math.min(...times)).toISOString(),
    newest: new Date(Math.max(...times)).toISOString(),
  }
}

export async function previewModuleArchive(
  businessId: string,
  moduleKey: string,
): Promise<PreviewRow> {
  const mod = resolveModule(moduleKey)
  if (!mod) throw new Error(`Unknown module: ${moduleKey}`)

  const ready = await isBusinessArchiveSchemaReady()
  const activeWhere = ready
    ? { businessId, isArchived: false }
    : { businessId }

  if (moduleKey === 'approvals') {
    const rows = await prisma.approvalRequest.findMany({
      where: ready
        ? { OR: [{ businessId }, { businessId: null }], isArchived: false }
        : { OR: [{ businessId }, { businessId: null }] },
      select: { id: true, createdAt: true },
      take: 5000,
    })
    const scoped = rows.filter(r => businessId === 'ALMA_TRADING' ? true : true)
    const dates = await aggregateDates(scoped.map(r => ({ createdAt: r.createdAt })))
    return { moduleKey, label: mod.label, count: scoped.length, oldestAt: dates.oldest, newestAt: dates.newest, storage: mod.storage }
  }

  if (moduleKey === 'attendance') {
    const [count, oldest, newest] = await Promise.all([
      prisma.attendanceRecord.count({ where: activeWhere }),
      prisma.attendanceRecord.findFirst({ where: activeWhere, orderBy: { attendanceDate: 'asc' }, select: { attendanceDate: true } }),
      prisma.attendanceRecord.findFirst({ where: activeWhere, orderBy: { attendanceDate: 'desc' }, select: { attendanceDate: true } }),
    ])
    return {
      moduleKey,
      label: mod.label,
      count,
      oldestAt: oldest?.attendanceDate?.toISOString() ?? null,
      newestAt: newest?.attendanceDate?.toISOString() ?? null,
      storage: mod.storage,
    }
  }

  if (moduleKey === 'attendance_waivers') {
    const [count, oldest, newest] = await Promise.all([
      prisma.attendanceWaiverRequest.count({ where: activeWhere }),
      prisma.attendanceWaiverRequest.findFirst({ where: activeWhere, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.attendanceWaiverRequest.findFirst({ where: activeWhere, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    return {
      moduleKey,
      label: mod.label,
      count,
      oldestAt: oldest?.createdAt?.toISOString() ?? null,
      newestAt: newest?.createdAt?.toISOString() ?? null,
      storage: mod.storage,
    }
  }

  if (moduleKey === 'wallet_requests') {
    const [count, oldest, newest] = await Promise.all([
      prisma.walletRequest.count({ where: activeWhere }),
      prisma.walletRequest.findFirst({ where: activeWhere, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.walletRequest.findFirst({ where: activeWhere, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    return { moduleKey, label: mod.label, count, oldestAt: oldest?.createdAt?.toISOString() ?? null, newestAt: newest?.createdAt?.toISOString() ?? null, storage: mod.storage }
  }

  if (moduleKey === 'expenses') {
    const [count, oldest, newest] = await Promise.all([
      prisma.employeeLedgerEntry.count({ where: activeWhere }),
      prisma.employeeLedgerEntry.findFirst({ where: activeWhere, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.employeeLedgerEntry.findFirst({ where: activeWhere, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    return { moduleKey, label: mod.label, count, oldestAt: oldest?.createdAt?.toISOString() ?? null, newestAt: newest?.createdAt?.toISOString() ?? null, storage: mod.storage }
  }

  if (moduleKey === 'invoices') {
    const [count, oldest, newest] = await Promise.all([
      prisma.invoiceRecord.count({ where: activeWhere }),
      prisma.invoiceRecord.findFirst({ where: activeWhere, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.invoiceRecord.findFirst({ where: activeWhere, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    return { moduleKey, label: mod.label, count, oldestAt: oldest?.createdAt?.toISOString() ?? null, newestAt: newest?.createdAt?.toISOString() ?? null, storage: mod.storage }
  }

  if (moduleKey === 'trading_trades') {
    const where = { businessId, deletedAt: null, ...(ready ? { isArchived: false } : {}) }
    const [count, oldest, newest] = await Promise.all([
      prisma.tradingTrade.count({ where }),
      prisma.tradingTrade.findFirst({ where, orderBy: { tradeDate: 'asc' }, select: { tradeDate: true } }),
      prisma.tradingTrade.findFirst({ where, orderBy: { tradeDate: 'desc' }, select: { tradeDate: true } }),
    ])
    return { moduleKey, label: mod.label, count, oldestAt: oldest?.tradeDate?.toISOString() ?? null, newestAt: newest?.tradeDate?.toISOString() ?? null, storage: mod.storage }
  }

  if (moduleKey === 'trading_expenses') {
    const where = { businessId, deletedAt: null, ...(ready ? { isArchived: false } : {}) }
    const [count, oldest, newest] = await Promise.all([
      prisma.tradingExpense.count({ where }),
      prisma.tradingExpense.findFirst({ where, orderBy: { expenseDate: 'asc' }, select: { expenseDate: true } }),
      prisma.tradingExpense.findFirst({ where, orderBy: { expenseDate: 'desc' }, select: { expenseDate: true } }),
    ])
    return { moduleKey, label: mod.label, count, oldestAt: oldest?.expenseDate?.toISOString() ?? null, newestAt: newest?.expenseDate?.toISOString() ?? null, storage: mod.storage }
  }

  if (moduleKey === 'telegram_drafts') {
    const [count, oldest, newest] = await Promise.all([
      prisma.tradingTelegramDraft.count({ where: activeWhere }),
      prisma.tradingTelegramDraft.findFirst({ where: activeWhere, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.tradingTelegramDraft.findFirst({ where: activeWhere, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    return { moduleKey, label: mod.label, count, oldestAt: oldest?.createdAt?.toISOString() ?? null, newestAt: newest?.createdAt?.toISOString() ?? null, storage: mod.storage }
  }

  if (moduleKey === 'orders') {
    try {
      const data = await serverGet<{ orders?: Array<{ id?: string; created_at?: string }> }>('orders', { business_id: businessId }, 0)
      const orders = (data.orders || []).filter(o => o.id)
      const times = orders.map(o => (o.created_at ? new Date(o.created_at).getTime() : NaN)).filter(Number.isFinite)
      return {
        moduleKey,
        label: mod.label,
        count: orders.length,
        oldestAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
        newestAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
        storage: mod.storage,
      }
    } catch {
      return { moduleKey, label: mod.label, count: 0, oldestAt: null, newestAt: null, storage: mod.storage }
    }
  }

  if (moduleKey === 'inventory' || moduleKey === 'crm') {
    return { moduleKey, label: mod.label, count: 0, oldestAt: null, newestAt: null, storage: mod.storage }
  }

  return { moduleKey, label: mod.label, count: 0, oldestAt: null, newestAt: null, storage: mod.storage }
}

export async function previewArchive(businessId: string, moduleKeys: string[]) {
  const rows = await Promise.all(moduleKeys.map(k => previewModuleArchive(businessId, k)))
  return {
    businessId,
    modules: rows,
    totalRecords: rows.reduce((s, r) => s + r.count, 0),
  }
}

const BATCH_SIZE = 500

async function markPrismaArchived(
  moduleKey: string,
  businessId: string,
  batchId: string,
  actorUserId: string,
  now: Date,
) {
  const data = {
    isArchived: true,
    archivedAt: now,
    archivedById: actorUserId,
    archiveBatchId: batchId,
  }

  if (moduleKey === 'approvals') {
    const rows = await prisma.approvalRequest.findMany({
      where: { isArchived: false, OR: [{ businessId }, { businessId: null }] },
      select: { id: true },
      take: 10000,
    })
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      await prisma.approvalRequest.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data })
    }
    return rows.map(r => ({ entityType: 'ApprovalRequest', entityId: r.id }))
  }

  if (moduleKey === 'attendance') {
    const rows = await prisma.attendanceRecord.findMany({
      where: { businessId, isArchived: false },
      select: { id: true },
    })
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      await prisma.attendanceRecord.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data })
    }
    return rows.map(r => ({ entityType: 'AttendanceRecord', entityId: r.id }))
  }

  if (moduleKey === 'attendance_waivers') {
    const rows = await prisma.attendanceWaiverRequest.findMany({
      where: { businessId, isArchived: false },
      select: { id: true },
    })
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      await prisma.attendanceWaiverRequest.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data })
    }
    return rows.map(r => ({ entityType: 'AttendanceWaiverRequest', entityId: r.id }))
  }

  if (moduleKey === 'wallet_requests') {
    const rows = await prisma.walletRequest.findMany({ where: { businessId, isArchived: false }, select: { id: true } })
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      await prisma.walletRequest.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data })
    }
    return rows.map(r => ({ entityType: 'WalletRequest', entityId: r.id }))
  }

  if (moduleKey === 'expenses') {
    const rows = await prisma.employeeLedgerEntry.findMany({ where: { businessId, isArchived: false }, select: { id: true } })
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      await prisma.employeeLedgerEntry.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data })
    }
    return rows.map(r => ({ entityType: 'EmployeeLedgerEntry', entityId: r.id }))
  }

  if (moduleKey === 'invoices') {
    const rows = await prisma.invoiceRecord.findMany({ where: { businessId, isArchived: false }, select: { id: true } })
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      await prisma.invoiceRecord.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data })
    }
    return rows.map(r => ({ entityType: 'InvoiceRecord', entityId: r.id }))
  }

  if (moduleKey === 'trading_trades') {
    const rows = await prisma.tradingTrade.findMany({
      where: { businessId, isArchived: false, deletedAt: null },
      select: { id: true },
    })
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      await prisma.tradingTrade.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data })
    }
    return rows.map(r => ({ entityType: 'TradingTrade', entityId: r.id }))
  }

  if (moduleKey === 'trading_expenses') {
    const rows = await prisma.tradingExpense.findMany({
      where: { businessId, isArchived: false, deletedAt: null },
      select: { id: true },
    })
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      await prisma.tradingExpense.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data })
    }
    return rows.map(r => ({ entityType: 'TradingExpense', entityId: r.id }))
  }

  if (moduleKey === 'telegram_drafts') {
    const rows = await prisma.tradingTelegramDraft.findMany({ where: { businessId, isArchived: false }, select: { id: true } })
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      await prisma.tradingTelegramDraft.updateMany({ where: { id: { in: chunk.map(r => r.id) } }, data })
    }
    return rows.map(r => ({ entityType: 'TradingTelegramDraft', entityId: r.id }))
  }

  return []
}

async function registryOnlyArchive(moduleKey: string, businessId: string) {
  if (moduleKey === 'orders') {
    try {
      const data = await serverGet<{ orders?: Array<{ id?: string }> }>('orders', { business_id: businessId }, 0)
      return (data.orders || []).filter(o => o.id).map(o => ({
        entityType: 'Order',
        entityId: String(o.id),
      }))
    } catch {
      return []
    }
  }
  return []
}

export async function executeModuleArchive(
  moduleKey: string,
  businessId: string,
  batchId: string,
  actorUserId: string,
) {
  const mod = resolveModule(moduleKey)
  if (!mod) throw new Error(`Unknown module: ${moduleKey}`)
  const now = new Date()

  const entities =
    mod.storage === 'registry'
      ? await registryOnlyArchive(moduleKey, businessId)
      : await markPrismaArchived(moduleKey, businessId, batchId, actorUserId, now)

  if (!entities.length) return 0

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const chunk = entities.slice(i, i + BATCH_SIZE)
    await prisma.businessArchiveEntity.createMany({
      data: chunk.map(e => ({
        batchId,
        businessId,
        moduleKey,
        entityType: e.entityType,
        entityId: e.entityId,
        archivedById: actorUserId,
        isArchived: true,
        archivedAt: now,
      })),
      skipDuplicates: true,
    })
  }

  return entities.length
}

export async function restoreBatch(batchId: string, actorUserId: string) {
  const batch = await prisma.businessArchiveBatch.findUnique({ where: { id: batchId } })
  if (!batch) throw new Error('Batch not found')

  const entities = await prisma.businessArchiveEntity.findMany({
    where: { batchId, isArchived: true },
  })
  const now = new Date()
  const moduleKeys = batch.moduleKeys.split(',').map(s => s.trim())

  for (const moduleKey of moduleKeys) {
    const ids = entities.filter(e => e.moduleKey === moduleKey).map(e => e.entityId)
    if (!ids.length) continue

    const clear = {
      isArchived: false,
      archivedAt: null,
      archivedById: null,
      archiveBatchId: null,
    }

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE)
      if (moduleKey === 'approvals') await prisma.approvalRequest.updateMany({ where: { id: { in: chunk } }, data: clear })
      else if (moduleKey === 'attendance') await prisma.attendanceRecord.updateMany({ where: { id: { in: chunk } }, data: clear })
      else if (moduleKey === 'attendance_waivers') await prisma.attendanceWaiverRequest.updateMany({ where: { id: { in: chunk } }, data: clear })
      else if (moduleKey === 'wallet_requests') await prisma.walletRequest.updateMany({ where: { id: { in: chunk } }, data: clear })
      else if (moduleKey === 'expenses') await prisma.employeeLedgerEntry.updateMany({ where: { id: { in: chunk } }, data: clear })
      else if (moduleKey === 'invoices') await prisma.invoiceRecord.updateMany({ where: { id: { in: chunk } }, data: clear })
      else if (moduleKey === 'trading_trades') await prisma.tradingTrade.updateMany({ where: { id: { in: chunk } }, data: clear })
      else if (moduleKey === 'trading_expenses') await prisma.tradingExpense.updateMany({ where: { id: { in: chunk } }, data: clear })
      else if (moduleKey === 'telegram_drafts') await prisma.tradingTelegramDraft.updateMany({ where: { id: { in: chunk } }, data: clear })
    }
  }

  await prisma.businessArchiveEntity.updateMany({
    where: { batchId },
    data: { isArchived: false, restoredAt: now, restoredById: actorUserId },
  })

  await prisma.businessArchiveBatch.update({
    where: { id: batchId },
    data: { status: 'RESTORED', restoredAt: now },
  })

  return entities.length
}

export async function getArchiveStats(businessId: string) {
  const mods = modulesForBusiness(businessId)
  const ready = await isBusinessArchiveSchemaReady()
  const stats = await Promise.all(
    mods.map(async m => {
      const active = await previewModuleArchive(businessId, m.key)
      let archived = 0
      if (ready) {
        try {
          archived = await prisma.businessArchiveEntity.count({
            where: { businessId, moduleKey: m.key, isArchived: true },
          })
        } catch {
          archived = 0
        }
      }
      return { moduleKey: m.key, label: m.label, activeCount: active.count, archivedCount: archived }
    }),
  )
  return stats
}

export function isValidBusinessId(id: string) {
  return Boolean(BUSINESSES[id as BusinessId])
}
