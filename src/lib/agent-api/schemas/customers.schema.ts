import { z } from 'zod'

export const AgentCustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  district: z.string().nullable().optional(),
  segment: z.string().nullable().optional(),
  totalOrders: z.number().int().nonnegative(),
  totalSpent: z.number().nonnegative(),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
})

export const CustomersListSchema = z.object({
  data: z.object({
    customers: z.array(AgentCustomerSchema),
    meta: z.object({ count: z.number().int().nonnegative(), limit: z.number().int().positive() }),
  }),
})

export const CreateCustomerBodySchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(6),
  address: z.string().optional(),
  district: z.string().optional(),
})

export const PatchCustomerBodySchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  district: z.string().optional(),
})

export const CustomerNoteBodySchema = z.object({
  note: z.string().min(1).max(2000),
})

export const CustomerTagBodySchema = z.object({
  tag: z.string().min(1).max(50),
})

export const ListCustomersQuerySchema = z.object({
  search: z.string().optional(),
  segment: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
