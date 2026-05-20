import type { BusinessId } from '@/lib/businesses'

export type ArchiveModuleDef = {
  key: string
  label: string
  description: string
  storage: 'prisma' | 'registry'
  businesses: BusinessId[] | 'ALL'
  /** Shown when live stats/integration unavailable */
  integrationNote?: string
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
  {
    key: 'orders',
    label: 'Orders',
    description: 'Order workspace (registry — GAS)',
    storage: 'registry',
    businesses: ['ALMA_LIFESTYLE', 'CREATIVE_DIGITAL_IT'],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    description: 'Stock/inventory (registry — GAS)',
    storage: 'registry',
    businesses: ['ALMA_LIFESTYLE'],
    integrationNote: 'Inventory archive registry integration pending — counts may show 0 until GAS linkage is enabled.',
  },
  {
    key: 'crm',
    label: 'CRM',
    description: 'CRM customers (registry — GAS)',
    storage: 'registry',
    businesses: ['ALMA_LIFESTYLE'],
    integrationNote: 'CRM archive registry integration unavailable — module listed for future archive batches.',
  },
]

export function modulesForBusiness(businessId: string): ArchiveModuleDef[] {
  return ARCHIVE_MODULES.filter(
    m => m.businesses === 'ALL' || (m.businesses as BusinessId[]).includes(businessId as BusinessId),
  )
}

export function resolveModule(key: string) {
  return ARCHIVE_MODULES.find(m => m.key === key) ?? null
}
