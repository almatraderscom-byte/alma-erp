import type { DefaultSession } from 'next-auth'
import type { UserRole } from '@prisma/client'

declare module 'next-auth' {
  interface Session {
    user: DefaultSession['user'] & {
      id: string
      role: UserRole
      businessAccess: string
      employeeIdGas?: string | null
      phone?: string | null
    }
  }

  interface User {
    id?: string
    role?: UserRole
    businessAccess?: string
    employeeIdGas?: string | null
    phone?: string | null
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string
    role?: UserRole
    businessAccess?: string
    employeeIdGas?: string | null
    phone?: string | null
  }
}
