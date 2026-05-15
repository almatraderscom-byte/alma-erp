export type PayrollTxType = 'advance' | 'deposit' | 'salary_payment' | 'adjustment'

export interface HREmployee {
  emp_id: string
  business_id: string
  name: string
  phone: string
  email: string
  address: string
  role: string
  joining_date: string
  monthly_salary: number
  status: string
  notes: string
}

export interface HRPayrollTransaction {
  tx_id: string
  date: string
  business_id: string
  emp_id: string
  emp_name: string
  tx_type: string
  amount: number
  period_ym: string
  note: string
}

export interface HREmployeesApi {
  employees: HREmployee[]
  total: number
}

export interface HRPayrollListApi {
  transactions: HRPayrollTransaction[]
  total: number
}

export interface HRDashboardKpis {
  total_monthly_salary: number
  monthly_payroll_budget?: number
  unpaid_salary_hint: number
  period_salary_paid?: number
  period_advances?: number
  advance_outstanding: number
  total_expenses: number
  monthly_revenue?: number
  order_gross_profit?: number
  employee_cost_budget?: number
  operational_expense?: number
  net_operation_hint: number
  net_business_profit_hint?: number
}

export interface EmployeePayrollRoll {
  emp_id: string
  name: string
  monthly_salary: number
  advance_balance: number
  deposits: number
  salary_paid: number
  adjustments: number
  current_due: number
}

export interface ERPFinanceExpense {
  exp_id: string
  date: string
  month?: string
  category: string
  business_id: string
  sub_cat?: string
  exp_type: string
  title: string
  desc?: string
  vendor?: string
  amount: number
  payment_method?: string
  payment_status?: string
  receipt_ref?: string
  recurring?: boolean
  notes?: string
}

export interface ERPFinanceResponse {
  total_expenses: number
  cash_balance: number
  by_category: Record<string, number>
  by_type?: Record<string, number>
  expenses: ERPFinanceExpense[]
  recent_expenses: ERPFinanceExpense[]
}

export interface HRDashboardApi {
  business_id: string
  kpis: HRDashboardKpis
  orders_summary?: Record<string, number>
  finance: ERPFinanceResponse
  employees_roll: EmployeePayrollRoll[]
  payroll_timeline?: HRPayrollTransaction[]
}

export interface PayrollRollComputed {
  advance_balance: number
  deposits: number
  salary_paid: number
  adjustments: number
  current_due: number
}
