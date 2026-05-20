import { logEvent } from '@/lib/logger'
import { classifyApprovalTxError } from '@/lib/safe-api-response'

export function classifyWalletMutationError(err: unknown) {
  const c = classifyApprovalTxError(err)
  logEvent('error', 'wallet.update.failed', {
    error: c.error,
    message: c.message,
  })
  return c
}
