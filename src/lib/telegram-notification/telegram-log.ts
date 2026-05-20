import { logEvent } from '@/lib/logger'

type Level = 'info' | 'warn' | 'error'

export function logTelegram(
  level: Level,
  event: string,
  meta: Record<string, unknown> = {},
) {
  logEvent(level, event, { surface: 'telegram-ops', ...meta })
}
