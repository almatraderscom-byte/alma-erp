import type { SearchableSelectOption } from '@/components/ui/SearchableSelect'

export type StaffOptionSource = {
  id: string
  name: string
  phone: string | null
  role: string
  employeeIdGas: string | null
  email?: string | null
}

export type AccountOptionSource = {
  id: string
  accountTitle: string
  assignedUser?: { name: string } | null
}

export function aliasByAccountIdFromRows(
  aliases: { alias: string; tradingAccountId: string; active: boolean }[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of aliases) {
    if (!row.active) continue
    if (!map.has(row.tradingAccountId)) map.set(row.tradingAccountId, row.alias)
  }
  return map
}

export function staffToSearchableOptions(staff: StaffOptionSource[]): SearchableSelectOption[] {
  return staff.map(s => {
    const hrId = s.employeeIdGas?.trim() || '—'
    const phone = s.phone?.trim() || ''
    return {
      value: s.id,
      label: `${s.name} — ${hrId} — ${s.role}`,
      sublabel: phone ? `Phone: ${phone}` : undefined,
      searchText: `${s.name} ${hrId} ${phone} ${s.role} ${s.email ?? ''}`.toLowerCase(),
    }
  })
}

export function accountToSearchableOptions(
  accounts: AccountOptionSource[],
  aliasByAccountId: Map<string, string>,
): SearchableSelectOption[] {
  return accounts.map(a => {
    const alias = aliasByAccountId.get(a.id)
    const label = alias ? `${a.accountTitle} (${alias})` : a.accountTitle
    return {
      value: a.id,
      label,
      sublabel: a.assignedUser?.name ? `Assigned: ${a.assignedUser.name}` : undefined,
      searchText: `${a.accountTitle} ${alias ?? ''} ${a.assignedUser?.name ?? ''}`.toLowerCase(),
    }
  })
}

export function resolveDefaultAlias(
  tradingAccountId: string,
  aliasByAccountId: Map<string, string>,
): string {
  if (!tradingAccountId) return ''
  return aliasByAccountId.get(tradingAccountId) ?? ''
}
