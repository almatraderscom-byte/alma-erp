import { z } from 'zod'

export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled'])

export const AgentTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  assignedTo: z.string(),
  assignedToName: z.string().optional(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  dueAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  fineAmountIfMissed: z.number().nonnegative().nullable().optional(),
})

export const TasksListSchema = z.object({
  data: z.object({
    tasks: z.array(AgentTaskSchema),
    meta: z.object({
      count: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      status: z.string().nullable().optional(),
      assignedTo: z.string().nullable().optional(),
      dueBefore: z.string().datetime().nullable().optional(),
    }),
  }),
})

export const CreateTaskBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  assignedTo: z.string().min(1),
  dueAt: z.string().datetime(),
  priority: TaskPrioritySchema.default('medium'),
  fineAmountIfMissed: z.number().nonnegative().nullable().optional(),
})

export const PatchTaskBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  assignedTo: z.string().optional(),
  dueAt: z.string().datetime().optional(),
  priority: TaskPrioritySchema.optional(),
  status: TaskStatusSchema.optional(),
  fineAmountIfMissed: z.number().nonnegative().nullable().optional(),
})

export const CompleteTaskBodySchema = z.object({
  completionNote: z.string().max(1000).nullable().optional(),
  completedAt: z.string().datetime().optional(),
})

export const ListTasksQuerySchema = z.object({
  status: z.string().optional(),
  assigned_to: z.string().optional(),
  due_before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
