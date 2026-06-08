import { z } from 'zod'

export const InventoryItemSchema = z.object({
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  currentStock: z.number().int(),
  reorderLevel: z.number().int(),
  status: z.string(),
})

export const InventoryListSchema = z.object({
  data: z.object({
    items: z.array(InventoryItemSchema),
    meta: z.object({ count: z.number().int().nonnegative() }),
  }),
})

export const InventoryAdjustBodySchema = z.object({
  adjustments: z.array(
    z.object({
      sku: z.string().min(1),
      delta: z.number().int(),
      reason: z.string().min(1).max(200),
    }),
  ),
  note: z.string().max(500).optional(),
})

export const InventoryMovementsQuerySchema = z.object({
  sku: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
