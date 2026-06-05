import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { normalizeLoginIdentifier } from '@/lib/phone'
import { errorMeta, logEvent } from '@/lib/logger'
import { normalizeBusinessAccessForRole } from '@/lib/business-access'

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        identifier: { label: 'Phone or Email', type: 'text' },
        email: { label: 'Phone or Email', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const identifier = normalizeLoginIdentifier(credentials?.identifier || credentials?.email)
        const password = credentials?.password
        if (!identifier.value || !password) return null

        const rawDb = process.env.DATABASE_URL?.trim()
        if (!rawDb) {
          logEvent('error', 'auth.database_url_missing')
          return null
        }
        if (/REPLACE_PROJECT_REF|REPLACE_PASSWORD/i.test(rawDb)) {
          logEvent('error', 'auth.database_url_placeholder')
          return null
        }

        try {
          const user = identifier.kind === 'email'
            ? await prisma.user.findUnique({ where: { email: identifier.value } })
            : await prisma.user.findUnique({ where: { phone: identifier.value } })
          if (!user?.active) return null
          if (
            process.env.NODE_ENV === 'production'
            && process.env.ENABLE_DEMO_USERS !== 'true'
            && (user.email?.endsWith('@alma-erp.demo') || user.phone?.startsWith('+880170000000'))
          ) {
            logEvent('warn', 'auth.demo_user_blocked', { userId: user.id })
            return null
          }

          const ok = await bcrypt.compare(password, user.passwordHash)
          if (!ok) return null

          return {
            id: user.id,
            email: user.email || user.phone || undefined,
            name: user.name,
            role: user.role,
            businessAccess: user.businessAccess,
            employeeIdGas: user.employeeIdGas,
            phone: user.phone,
          }
        } catch (e) {
          logEvent('error', 'auth.database_lookup_failed', errorMeta(e))
          return null
        }
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: Number(process.env.SESSION_MAX_AGE_SECONDS || 30 * 24 * 60 * 60),
  },
  cookies: process.env.NODE_ENV === 'production'
    ? {
        sessionToken: {
          name: '__Secure-next-auth.session-token',
          options: {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure: true,
          },
        },
      }
    : undefined,
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.email = user.email
        token.name = user.name
        token.role = user.role as UserRole
        token.businessAccess = normalizeBusinessAccessForRole((user as { businessAccess?: string }).businessAccess, user.role as string)
        token.employeeIdGas = (user as { employeeIdGas?: string | null }).employeeIdGas ?? ''
        token.phone = (user as { phone?: string | null }).phone ?? ''
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as UserRole
        session.user.businessAccess = normalizeBusinessAccessForRole(token.businessAccess as string, token.role as string)
        session.user.employeeIdGas = (token.employeeIdGas as string) || ''
        session.user.phone = (token.phone as string) || ''
      }
      return session
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
}
