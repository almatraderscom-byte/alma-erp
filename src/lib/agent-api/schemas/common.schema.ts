import { z } from 'zod'

export const AgentMetaSchema = z.object({
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive().optional(),
})

export const WriteConfirmSchema = z.object({
  id: z.string(),
  status: z.string(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
})

export type AgentMeta = z.infer<typeof AgentMetaSchema>
