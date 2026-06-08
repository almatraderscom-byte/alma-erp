import { z } from 'zod'

export const OrderStatusSchema = z.enum([
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
])

export const AgentOrderSchema = z.object({
  id: z.string().min(1),
  orderNumber: z.string().optional(),
  customerName: z.string().nullable(),
  customerPhone: z.string().nullable(),
  totalAmount: z.number().nonnegative(),
  currency: z.literal('BDT'),
  status: OrderStatusSchema,
  placedAt: z.string().datetime(),
  itemCount: z.number().int().nonnegative().optional(),
  paymentMethod: z.string().nullable().optional(),
  shippingCity: z.string().nullable().optional(),
})

export const AgentOrdersListSchema = z.object({
  orders: z.array(AgentOrderSchema),
  meta: z.object({
    count: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    from: z.string().datetime().nullable(),
    to: z.string().datetime().nullable(),
  }),
})

export const AgentOrderLineItemSchema = z.object({
  sku: z.string().optional(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  lineTotal: z.number().nonnegative(),
})

export const AgentOrderDetailSchema = AgentOrderSchema.extend({
  lineItems: z.array(AgentOrderLineItemSchema).optional(),
  notes: z.string().nullable().optional(),
})

export const SummaryPeriodSchema = z.enum(['today', 'yesterday', 'week', 'month'])

export const AgentOrdersSummarySchema = z.object({
  period: SummaryPeriodSchema,
  totalOrders: z.number().int().nonnegative(),
  totalRevenue: z.number().nonnegative(),
  currency: z.literal('BDT'),
  avgOrderValue: z.number().nonnegative(),
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  generatedAt: z.string().datetime(),
})

export const ListOrdersQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

export type AgentOrder = z.infer<typeof AgentOrderSchema>
export type AgentOrderDetail = z.infer<typeof AgentOrderDetailSchema>
export type AgentOrdersSummary = z.infer<typeof AgentOrdersSummarySchema>
export type SummaryPeriod = z.infer<typeof SummaryPeriodSchema>
