import type { ERPFinanceExpense } from '@/types/hr'

function escapeCsv(cell: string) {
  if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`
  return cell
}

export function expensesToCsv(rows: ERPFinanceExpense[]): string {
  const header = ['date', 'title', 'category', 'amount', 'payment_status', 'payment_method', 'recurring', 'notes', 'receipt']
  const lines = rows.map(r =>
    [
      r.date,
      r.title || '',
      r.category || '',
      String(r.amount ?? 0),
      r.payment_status || '',
      r.payment_method || '',
      r.recurring ? 'yes' : 'no',
      (r.notes || '').replace(/\r?\n/g, ' '),
      r.receipt_ref || '',
    ].map(v => escapeCsv(String(v))).join(','),
  )
  return '\ufeff' + header.join(',') + '\n' + lines.join('\n')
}

export async function expensesToWorkbook(rows: ERPFinanceExpense[]) {
  const XLSX = await import('xlsx')
  const header = [['date', 'title', 'category', 'amount', 'payment_status', 'payment_method', 'recurring', 'notes', 'receipt']]
  const data = rows.map(r => [
    r.date,
    r.title || '',
    r.category || '',
    String(r.amount ?? 0),
    r.payment_status || '',
    r.payment_method || '',
    r.recurring ? 'yes' : 'no',
    r.notes || '',
    r.receipt_ref || '',
  ])
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(header.concat(data))
  XLSX.utils.book_append_sheet(wb, ws, 'Expenses')
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
