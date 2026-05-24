/**
 * Whole-taka money helpers (Alma ERP — no paisa).
 */

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value)
}

export function parseMoneyInput(raw: string | number | undefined): number {
  if (typeof raw === 'number') return roundMoney(raw)
  if (raw == null || raw === '') return 0
  const cleaned = String(raw).replace(/[^0-9.\-]/g, '')
  const num = Number(cleaned)
  if (!Number.isFinite(num)) return 0
  return roundMoney(num)
}

export function formatMoneyBDT(value: number): string {
  const rounded = roundMoney(value)
  return `৳${rounded.toLocaleString('en-BD')}`
}
