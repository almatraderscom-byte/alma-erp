import { captureAgentEvent } from '@/agent/lib/sentry'
import { logEvent } from '@/lib/logger'
import type { MigrationReadDomain } from '@/lib/migration-flags'

export function logMirrorFailure(
  domain: MigrationReadDomain | 'invoice_sequence',
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  const message = err instanceof Error ? err.message : String(err)
  logEvent('error', `migration.mirror_${domain}_failed`, { error: message, ...meta })
  void captureAgentEvent('error', `migration.mirror_${domain}_failed`, { error: message, ...meta })
}

export function scheduleMirror(
  fn: () => Promise<void>,
  domain: MigrationReadDomain | 'invoice_sequence',
  meta?: Record<string, unknown>,
): void {
  void fn().catch(err => logMirrorFailure(domain, err, meta))
}
