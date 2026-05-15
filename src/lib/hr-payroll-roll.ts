import type { HREmployee, HRPayrollTransaction, PayrollRollComputed } from '@/types/hr'

export function computePayrollRoll(emp: HREmployee, txs: HRPayrollTransaction[]): PayrollRollComputed {
  let advance_balance = 0
  let deposits = 0
  let salary_paid = 0
  let adjustments = 0

  for (const t of txs.filter(x => x.emp_id === emp.emp_id)) {
    const amt = Number(t.amount || 0)
    if (t.tx_type === 'advance') advance_balance += amt
    else if (t.tx_type === 'deposit') {
      deposits += amt
      advance_balance -= amt
    } else if (t.tx_type === 'salary_payment') salary_paid += amt
    else if (t.tx_type === 'adjustment') adjustments += amt
  }

  const monthly_salary = Number(emp.monthly_salary || 0)
  const current_due = monthly_salary - salary_paid + Math.max(0, advance_balance)

  return { advance_balance, deposits, salary_paid, adjustments, current_due }
}
