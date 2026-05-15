export type CditProjectStatus = 'Lead' | 'Proposal' | 'Active' | 'Review' | 'Completed' | 'On Hold' | 'Cancelled'
export type CditPriority = 'Low' | 'Medium' | 'High' | 'Urgent'
export type CditInvoiceStatus = 'Draft' | 'Sent' | 'Paid' | 'Overdue' | 'Cancelled' | 'Partial Paid'
export type CditInvoiceType = 'one-time' | 'recurring'
export type CditPaymentType = 'income' | 'expense'
export type CditPaymentStatus = 'Unpaid' | 'Partial Paid' | 'Paid'

export const CDIT_SERVICES = [
  'Website Development',
  'Facebook Marketing',
  'SEO',
  'Branding',
  'Video Editing',
  'Graphics',
  'Monthly Retainer',
] as const

export const CDIT_PAYMENT_METHODS = [
  'Bank Transfer',
  'bKash',
  'Nagad',
  'Cash',
  'PayPal',
  'Stripe',
  'Other',
] as const

export interface CditFinanceFields {
  total_amount: number
  total_paid: number
  due_amount: number
  payment_percentage: number
  payment_status: CditPaymentStatus
}

export interface CditClient {
  id: string
  business_id: string
  name: string
  company: string
  phone: string
  email: string
  country: string
  service_type: string
  lead_source: string
  notes: string
  tags: string
  created_at: string
  created_by?: string
  updated_at?: string
}

export interface CditProject extends CditFinanceFields {
  id: string
  business_id: string
  client_id: string
  client_name: string
  project_name: string
  title?: string
  service_type: string
  status: CditProjectStatus
  currency: string
  start_date: string
  deadline: string
  assigned_to: string
  priority: CditPriority
  files_url: string
  notes: string
  comments?: string
  created_at: string
  created_by?: string
  updated_at?: string
}

export interface CditInvoice extends CditFinanceFields {
  id: string
  business_id: string
  client_id: string
  project_id: string
  client_name: string
  invoice_type: CditInvoiceType
  amount: number
  status: CditInvoiceStatus
  due_date: string
  issued_date: string
  recurring_interval: string
  pdf_url: string
  notes: string
  created_at?: string
  created_by?: string
  updated_at?: string
}

export interface CditPayment {
  id: string
  business_id: string
  project_id: string
  client_id: string
  invoice_id: string
  client_name: string
  amount: number
  payment_method: string
  transaction_id: string
  payment_date: string
  date?: string
  note: string
  notes?: string
  payment_type: CditPaymentType
  category: string
  created_at?: string
  created_by?: string
}

export interface CditClientDetail {
  client: CditClient
  summary: CditFinanceFields
  projects: CditProject[]
  invoices: CditInvoice[]
  payments: CditPayment[]
  timeline: CditPayment[]
}

export interface CditDashboardData {
  kpis: {
    total_clients: number
    active_projects: number
    mrr: number
    recurring_revenue: number
    total_revenue: number
    total_expenses: number
    net_profit: number
    total_receivable: number
    collected_this_month: number
    unpaid_invoices: number
    partially_paid_projects: number
    overdue_invoices: number
  }
  by_service: Record<string, number>
  by_status: Record<string, number>
  recent_invoices: CditInvoice[]
  recent_projects: CditProject[]
  partial_projects?: CditProject[]
}

export interface FinancialReport {
  business_id: string
  period_label: string
  total_receivable?: number
  monthly_revenue: Array<{ month: string; revenue: number; profit: number; expenses: number }>
  yearly_growth_pct: number
  profit_loss: { revenue: number; cogs: number; expenses: number; net_profit: number; margin_pct: number }
  cashflow: { inflow: number; outflow: number; net: number }
  invoice_history: Array<{
    id: string
    client: string
    amount: number
    status: string
    date: string
    total_paid?: number
    due_amount?: number
  }>
  top_clients_clv: Array<{ name: string; revenue: number; orders: number }>
}
