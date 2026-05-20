import { logEvent } from '@/lib/logger'

export type PlatformDiagnosticEvent =
  | 'platform.shell.mounted'
  | 'platform.shell.hydration_mismatch'
  | 'platform.watermark.missing'
  | 'platform.provider.depth_warning'

export function logPlatformDiagnostic(
  event: PlatformDiagnosticEvent,
  meta?: Record<string, unknown>,
) {
  const level = event.includes('missing') || event.includes('mismatch') ? 'warn' : 'info'
  logEvent(level, event, meta)
}
