import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

if (typeof window === 'undefined' && !process.env.DATABASE_URL?.trim()) {
  console.warn(
    '[prisma] DATABASE_URL is not set — authentication and user APIs will fail until Postgres is configured (see docs/SUPABASE_POSTGRES_SETUP.md).',
  )
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

// Reuse one client per serverless isolate (critical for Supabase pool limits on Vercel).
globalForPrisma.prisma = prisma
