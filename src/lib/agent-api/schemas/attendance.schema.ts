import { z } from 'zod'

export const AttendanceTodaySchema = z.object({
  data: z.object({
    date: z.string(),
    present: z.array(
      z.object({
        employeeId: z.string(),
        name: z.string(),
        checkIn: z.string().datetime().nullable(),
        onTime: z.boolean(),
      }),
    ),
    absent: z.array(z.object({ employeeId: z.string(), name: z.string() })),
    late: z.array(
      z.object({
        employeeId: z.string(),
        name: z.string(),
        checkIn: z.string().datetime(),
        minutesLate: z.number().int().nonnegative(),
      }),
    ),
    notYetCheckedIn: z.array(z.object({ employeeId: z.string(), name: z.string() })),
  }),
})

export const AttendanceHistorySchema = z.object({
  data: z.object({
    employeeId: z.string(),
    days: z.array(
      z.object({
        date: z.string(),
        status: z.string(),
        checkIn: z.string().datetime().nullable(),
        checkOut: z.string().datetime().nullable(),
        hoursWorked: z.number().nullable(),
      }),
    ),
    stats: z.object({
      presentDays: z.number().int().nonnegative(),
      absentDays: z.number().int().nonnegative(),
      lateDays: z.number().int().nonnegative(),
      attendanceRatePct: z.number().min(0).max(100),
    }),
  }),
})

export const ManualAttendanceBodySchema = z.object({
  employeeId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkInAt: z.string().datetime(),
  checkOutAt: z.string().datetime().optional(),
  note: z.string().max(500).optional(),
})

export const PatchAttendanceBodySchema = z.object({
  checkInAt: z.string().datetime().optional(),
  checkOutAt: z.string().datetime().optional(),
  lateMinutes: z.number().int().nonnegative().optional(),
  note: z.string().max(500).optional(),
})

export const AttendanceHistoryQuerySchema = z.object({
  employee_id: z.string().min(1),
  days: z.coerce.number().int().min(1).max(90).default(30),
})
