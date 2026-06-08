import { z } from 'zod'

export const AgentProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  price: z.number().nonnegative(),
  stock: z.number().int(),
  sku: z.string().nullable().optional(),
  archived: z.boolean().default(false),
})

export const ProductsListSchema = z.object({
  data: z.object({
    products: z.array(AgentProductSchema),
    meta: z.object({ count: z.number().int().nonnegative() }),
  }),
})

export const CreateProductBodySchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  price: z.number().nonnegative(),
  sku: z.string().optional(),
  stock: z.number().int().nonnegative().optional(),
})

export const PatchProductBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
})

export const PatchProductPricingBodySchema = z.object({
  price: z.number().nonnegative(),
  note: z.string().max(200).optional(),
})

export const PatchProductInventoryBodySchema = z.object({
  delta: z.number().int(),
  reason: z.string().min(1).max(200),
})

export const ListProductsQuerySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
