import { z } from 'zod'

export const ReportsSalesQuerySchema = z.object({
  period: z.enum(['today', 'yesterday', 'week', 'month']).default('today'),
  groupBy: z.enum(['category', 'product']).optional(),
})

export const ReportsInventoryQuerySchema = z.object({
  slowDays: z.coerce.number().int().min(7).max(365).default(90),
})

export const ReportsCustomersQuerySchema = z.object({
  period: z.enum(['week', 'month', 'year']).default('month'),
  top: z.coerce.number().int().min(5).max(50).default(10),
})

export const ReportsEmployeesQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
})

export const ReportsFinanceQuerySchema = z.object({
  period: z.enum(['today', 'week', 'month']).default('month'),
})

export const AuditRecentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const AuditByActionQuerySchema = z.object({
  action: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const SettingsPatchBusinessHoursSchema = z.object({
  officeStartMinutes: z.number().int().min(0).max(1440),
  officeEndMinutes: z.number().int().min(0).max(1440),
})

export const SettingsPatchHolidaysSchema = z.object({
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
})

export const SettingsPatchLateThresholdSchema = z.object({
  lateThresholdMinutes: z.number().int().min(0).max(120),
})

export const SettingsPatchFinePolicySchema = z.object({
  autoPenaltyEnabled: z.boolean().optional(),
  defaultPenaltyBdt: z.number().nonnegative().optional(),
  taskOverdueFineBdt: z.number().nonnegative().optional(),
})

export const OrderCancelBodySchema = z.object({
  reason: z.string().min(1).max(500),
})

export const OrderRefundBodySchema = z.object({
  amount: z.number().positive().optional(),
  full: z.boolean().default(false),
  reason: z.string().min(1).max(500),
})

export const OrderStatusBodySchema = z.object({
  status: z.string().min(1),
  reason: z.string().max(500).optional(),
})

export const OrderNoteBodySchema = z.object({
  note: z.string().min(1).max(2000),
})
