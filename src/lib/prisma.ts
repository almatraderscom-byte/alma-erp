import { PrismaClient } from '@prisma/client'
import { capturePrismaError } from '@/lib/sentry/capture'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

if (typeof window === 'undefined' && !process.env.DATABASE_URL?.trim()) {
  console.warn(
    '[prisma] DATABASE_URL is not set — authentication and user APIs will fail until Postgres is configured (see docs/SUPABASE_POSTGRES_SETUP.md).',
  )
}

function createPrismaClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
  return base.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        return query(args).catch((err: unknown) => {
          void capturePrismaError(err, { model, operation })
          throw err
        })
      },
    },
  })
}

export const prisma = (globalForPrisma.prisma ?? createPrismaClient()) as unknown as PrismaClient

// Reuse one client per serverless isolate (critical for Supabase pool limits on Vercel).
globalForPrisma.prisma = prisma
