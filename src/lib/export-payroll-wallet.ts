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
  const { default: writeExcelFile } = await import('write-excel-file/browser')
  const rows = [
    ['Business', 'Employee ID', 'Name', 'Email', 'Monthly Salary', 'Salary Earned', 'Commission', 'Bonuses', 'Overtime', 'Reimbursements', 'Meal Deductions', 'Penalties', 'Lifetime Earned', 'Lifetime Withdrawn', 'Current Balance', 'Company Liability'],
    ...wallets.map(w => [
      w.businessId,
      w.employeeId,
      w.name,
      w.email || '',
      w.monthlySalary || 0,
      w.summary.totalAccrued,
      w.summary.totalCommissions,
      w.summary.totalBonuses,
      w.summary.totalOvertime,
      w.summary.totalReimbursements,
      w.summary.totalMealDeductions,
      w.summary.totalPenalties,
      w.summary.lifetimeEarned,
      w.summary.lifetimeWithdrawn,
      w.summary.currentBalance,
      w.summary.companyLiability,
    ]),
  ]
  return writeExcelFile(rows, { sheet: 'Payroll Wallets' }).toBlob()
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
