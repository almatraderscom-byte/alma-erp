import type { PayrollWallet } from '@/types/payroll-wallet'

export function payrollWalletsToCsv(wallets: PayrollWallet[]) {
  const rows = [
    ['Business', 'Employee ID', 'Name', 'Email', 'Monthly Salary', 'Salary Earned', 'Commission', 'Bonuses', 'Overtime', 'Reimbursements', 'Meal Deductions', 'Penalties', 'Lifetime Earned', 'Lifetime Withdrawn', 'Current Balance', 'Company Liability'],
    ...wallets.map(w => [
      w.businessId,
      w.employeeId,
      w.name,
      w.email || '',
      String(w.monthlySalary || 0),
      String(w.summary.totalAccrued),
      String(w.summary.totalCommissions),
      String(w.summary.totalBonuses),
      String(w.summary.totalOvertime),
      String(w.summary.totalReimbursements),
      String(w.summary.totalMealDeductions),
      String(w.summary.totalPenalties),
      String(w.summary.lifetimeEarned),
      String(w.summary.lifetimeWithdrawn),
      String(w.summary.currentBalance),
      String(w.summary.companyLiability),
    ]),
  ]
  return rows.map(row => row.map(csvCell).join(',')).join('\n')
}

function csvCell(v: string) {
  return `"${String(v).replace(/"/g, '""')}"`
}

export async function payrollWalletsToWorkbook(wallets: PayrollWallet[]) {
  const XLSX = await import('xlsx')
  const sheetRows = wallets.map(w => ({
    Business: w.businessId,
    'Employee ID': w.employeeId,
    Name: w.name,
    Email: w.email || '',
    'Monthly Salary': w.monthlySalary || 0,
    'Salary Earned': w.summary.totalAccrued,
    Commission: w.summary.totalCommissions,
    Bonuses: w.summary.totalBonuses,
    Overtime: w.summary.totalOvertime,
    Reimbursements: w.summary.totalReimbursements,
    'Meal Deductions': w.summary.totalMealDeductions,
    Penalties: w.summary.totalPenalties,
    'Lifetime Earned': w.summary.lifetimeEarned,
    'Lifetime Withdrawn': w.summary.lifetimeWithdrawn,
    'Current Balance': w.summary.currentBalance,
    'Company Liability': w.summary.companyLiability,
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), 'Payroll Wallets')
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
