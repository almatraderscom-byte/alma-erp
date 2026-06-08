import { z } from 'zod'

export const AgentPromoSchema = z.object({
  id: z.string(),
  code: z.string(),
  discountPct: z.number().min(0).max(100).nullable(),
  discountAmount: z.number().nonnegative().nullable(),
  active: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
  usageCount: z.number().int().nonnegative().default(0),
})

export const PromosListSchema = z.object({
  data: z.object({
    promos: z.array(AgentPromoSchema),
    meta: z.object({ count: z.number().int().nonnegative() }),
  }),
})

export const CreatePromoBodySchema = z.object({
  code: z.string().min(2).max(32),
  discountPct: z.number().min(0).max(100).optional(),
  discountAmount: z.number().nonnegative().optional(),
  expiresAt: z.string().datetime().optional(),
})

export const PatchPromoBodySchema = z.object({
  discountPct: z.number().min(0).max(100).optional(),
  discountAmount: z.number().nonnegative().optional(),
  expiresAt: z.string().datetime().optional(),
  extendDays: z.number().int().positive().optional(),
})
