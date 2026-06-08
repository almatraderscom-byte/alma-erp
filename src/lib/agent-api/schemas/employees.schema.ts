import { z } from 'zod'

/** Maps GAS hr_employees + Prisma User.telegram link. */
export const AgentEmployeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  phone: z.string().nullable(),
  active: z.boolean(),
  joinedAt: z.string().datetime(),
  telegramId: z.string().nullable().optional(),
})

export const EmployeesListSchema = z.object({
  data: z.object({
    employees: z.array(AgentEmployeeSchema),
    meta: z.object({
      count: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      active: z.boolean().nullable().optional(),
      search: z.string().nullable().optional(),
    }),
  }),
})

export const EmployeeDetailSchema = z.object({
  data: AgentEmployeeSchema.extend({
    pendingTasksCount: z.number().int().nonnegative(),
    totalFinesThisMonth: z.number().nonnegative(),
    recentAttendance: z
      .object({
        presentDays: z.number().int().nonnegative(),
        absentDays: z.number().int().nonnegative(),
        lateDays: z.number().int().nonnegative(),
      })
      .optional(),
  }),
})

export const CreateEmployeeBodySchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  role: z.string().optional(),
  joiningDate: z.string().optional(),
  monthlySalary: z.number().nonnegative().optional(),
})

export const PatchEmployeeBodySchema = CreateEmployeeBodySchema.partial()

export const ListEmployeesQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().optional(),
})

export type AgentEmployee = z.infer<typeof AgentEmployeeSchema>
