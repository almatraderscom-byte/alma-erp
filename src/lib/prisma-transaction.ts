import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { errorMeta, logEvent } from '@/lib/logger'

export type ApprovalTx = Prisma.TransactionClient

/** Serverless-safe defaults: short transactions, longer pool wait under contention. */
export const APPROVAL_TX_OPTIONS = {
  maxWait: 12_000,
  timeout: 10_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
} as const

export const FAST_TX_OPTIONS = {
  maxWait: 12_000,
  timeout: 8_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
} as const

function classifyTxError(message: string): string {
  if (message.includes('Unable to start a transaction')) return 'approval.tx.pool_wait'
  if (message.includes('deadlock') || message.includes('40P01')) return 'approval.tx.deadlock'
  if (
    message.includes('timed out')
    || message.includes('Transaction already closed')
    || message.includes('expired transaction')
  ) {
    return 'approval.tx.timeout'
  }
  return 'approval.tx.rollback'
}

export async function runApprovalTransaction<T>(
  label: string,
  fn: (tx: ApprovalTx) => Promise<T>,
  options: {
    maxWait?: number
    timeout?: number
    isolationLevel?: Prisma.TransactionIsolationLevel
  } = APPROVAL_TX_OPTIONS,
): Promise<T> {
  const started = Date.now()
  logEvent('info', 'approval.tx.start', { label })
  try {
    const result = await prisma.$transaction(fn, options)
    logEvent('info', 'approval.tx.commit', {
      label,
      durationMs: Date.now() - started,
    })
    return result
  } catch (error) {
    const message = (error as Error).message || String(error)
    logEvent('error', classifyTxError(message), {
      label,
      durationMs: Date.now() - started,
      ...errorMeta(error),
    })
    throw error
  }
}

/** Run non-critical work after commit without blocking the HTTP response path. */
export function deferAfterApprovalCommit(label: string, fn: () => Promise<void>) {
  void fn().catch(err => {
    logEvent('warn', 'approval.side_effect.failed', { label, ...errorMeta(err) })
  })
}

export function getPrisma(): PrismaClient {
  return prisma
}
