import { PENDING_ACTION_EXPIRY_MS } from '@/agent/lib/constants'

export function pendingActionAgeMs(createdAt: Date | string): number {
  return Date.now() - new Date(createdAt).getTime()
}

export function isPendingActionExpired(createdAt: Date | string): boolean {
  return pendingActionAgeMs(createdAt) > PENDING_ACTION_EXPIRY_MS
}
