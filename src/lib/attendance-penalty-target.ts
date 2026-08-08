export type AttendancePenaltyKind = 'LATE' | 'EARLY_LEAVE' | 'NO_CHECKOUT'

export type AttendancePenaltyRecord = {
  penaltyAmount?: unknown
  penaltyLedgerEntryId?: string | null
  lateMinutes?: number | null
  earlyLeavePenaltyAmount?: unknown
  earlyLeavePenaltyLedgerEntryId?: string | null
  earlyLeaveMinutes?: number | null
  noCheckoutFineAmount?: unknown
  noCheckoutFineLedgerEntryId?: string | null
}

export type AttendancePenaltyTarget = {
  kind: AttendancePenaltyKind
  ledgerEntryId: string
  amount: number
  minutes: number
}

export function attendancePenaltyKindLabel(kind: AttendancePenaltyKind): string {
  if (kind === 'EARLY_LEAVE') return 'Early check-out penalty'
  if (kind === 'NO_CHECKOUT') return 'No check-out penalty'
  return 'Late check-in penalty'
}

export function attendancePenaltyTargets(record: AttendancePenaltyRecord): AttendancePenaltyTarget[] {
  const rows = [
    { kind: 'LATE' as const, ledgerEntryId: record.penaltyLedgerEntryId, amount: Number(record.penaltyAmount || 0), minutes: Number(record.lateMinutes || 0) },
    { kind: 'EARLY_LEAVE' as const, ledgerEntryId: record.earlyLeavePenaltyLedgerEntryId, amount: Number(record.earlyLeavePenaltyAmount || 0), minutes: Number(record.earlyLeaveMinutes || 0) },
    { kind: 'NO_CHECKOUT' as const, ledgerEntryId: record.noCheckoutFineLedgerEntryId, amount: Number(record.noCheckoutFineAmount || 0), minutes: 0 },
  ]

  return rows.filter((row): row is AttendancePenaltyTarget => (
    typeof row.ledgerEntryId === 'string'
    && row.ledgerEntryId.length > 0
    && Number.isFinite(row.amount)
    && row.amount > 0
  ))
}

/** Exact links win. Legacy rows resolve only when one posted fine uniquely matches the amount. */
export function resolveAttendancePenaltyTarget(
  record: AttendancePenaltyRecord,
  linkedLedgerEntryId: string | null | undefined,
  originalPenaltyAmount: unknown,
): AttendancePenaltyTarget | null {
  const targets = attendancePenaltyTargets(record)
  if (linkedLedgerEntryId) {
    return targets.find(target => target.ledgerEntryId === linkedLedgerEntryId) ?? null
  }
  const original = Number(originalPenaltyAmount || 0)
  if (!Number.isFinite(original) || original <= 0) return null
  const matches = targets.filter(target => Math.abs(target.amount - original) < 0.01)
  return matches.length === 1 ? matches[0] : null
}
