import { z } from 'zod'

export const AgentFineSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  employeeName: z.string(),
  amount: z.number().nonnegative(),
  reason: z.string(),
  taskId: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  awaitingApproval: z.boolean(),
  status: z.string().optional(),
})

export const FinesListSchema = z.object({
  data: z.object({
    fines: z.array(AgentFineSchema),
    meta: z.object({ count: z.number().int().nonnegative() }),
  }),
})

export const CreateFineBodySchema = z.object({
  employeeId: z.string().min(1),
  amount: z.number().positive(),
  reason: z.string().min(1).max(500),
  taskId: z.string().optional(),
})

export const ApproveFineBodySchema = z.object({
  approvedBy: z.literal('agent_via_sir'),
  note: z.string().max(500).optional(),
})

export const WaiveFineBodySchema = z.object({
  waivedBy: z.literal('agent_via_sir'),
  reason: z.string().min(1).max(500),
})

export const ListFinesQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'waived', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
