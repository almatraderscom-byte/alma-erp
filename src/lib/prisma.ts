import { PrismaClient } from '@prisma/client'
import { capturePrismaError } from '@/lib/sentry/capture'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

if (typeof window === 'undefined' && !process.env.DATABASE_URL?.trim()) {
  console.warn(
    '[prisma] DATABASE_URL is not set — authentication and user APIs will fail until Postgres is configured (see docs/SUPABASE_POSTGRES_SETUP.md).',
  )
}

/**
 * Prisma P2024 = "Timed out fetching a new connection from the connection pool".
 * On the Tokyo Supabase pooler each query is ~700ms, and an agent turn fires ~13
 * reads at once, so under load the per-client pool can briefly run dry and a turn
 * crashed with a 500 (the owner saw "সমস্যা হয়েছে / /new" on Telegram).
 *
 * A P2024 means the operation NEVER ran (it timed out BEFORE getting a connection),
 * so retrying is completely safe — it can never double-write/double-charge. We retry
 * a couple of times with a short backoff to ride out the transient contention. The
 * real capacity fix is still raising connection_limit/pool_timeout on DATABASE_URL.
 */
function isPoolTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: string }).code
  if (code === 'P2024') return true
  const msg = (err as { message?: string }).message ?? ''
  return /connection pool/i.test(msg) && /timed out/i.test(msg)
}

const POOL_RETRY_BACKOFF_MS = [150, 400, 800]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function createPrismaClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
  return base.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        let lastErr: unknown
        for (let attempt = 0; attempt <= POOL_RETRY_BACKOFF_MS.length; attempt++) {
          try {
            return await query(args)
          } catch (err: unknown) {
            lastErr = err
            // Only a connection-pool timeout is safe to retry (the query never ran).
            if (isPoolTimeout(err) && attempt < POOL_RETRY_BACKOFF_MS.length) {
              await sleep(POOL_RETRY_BACKOFF_MS[attempt])
              continue
            }
            void capturePrismaError(err, { model, operation })
            // Short, greppable failure marker so the failing model+operation+code is
            // readable in truncated log viewers (the full Prisma message is too long).
            {
              const e = err as { code?: string; name?: string }
              console.error(`PRISMAFAIL ${model ?? '?'}.${operation ?? '?'} ${e?.code ?? e?.name ?? 'ERR'}`)
            }
            throw err
          }
        }
        throw lastErr
      },
    },
  })
}

export const prisma = (globalForPrisma.prisma ?? createPrismaClient()) as unknown as PrismaClient

// Reuse one client per serverless isolate (critical for Supabase pool limits on Vercel).
globalForPrisma.prisma = prisma
