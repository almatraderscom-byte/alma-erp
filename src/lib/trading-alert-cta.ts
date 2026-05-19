export type TradingAlertAction = 'screenshot' | 'summary' | 'trade' | 'view'

export type TradingAlertCta = {
  label: string
  action: TradingAlertAction
}

export function parseTradingAlertType(alertKey: string): string {
  const idx = alertKey.indexOf(':')
  return idx >= 0 ? alertKey.slice(idx + 1) : alertKey
}

export function getTradingAlertCta(alertKey: string): TradingAlertCta {
  const type = parseTradingAlertType(alertKey)
  if (type === 'missing-screenshot' || type === 'missing-screenshot-today') return { label: 'Upload Now', action: 'screenshot' }
  if (type === 'missing-daily-summary') return { label: 'Add Summary', action: 'summary' }
  if (type === 'critical-balance' || type === 'loss-threshold' || type === 'loss-streak') {
    return { label: 'Add Trade', action: 'trade' }
  }
  return { label: 'Open Account', action: 'view' }
}

export function tradingAccountTabForAction(action: TradingAlertAction): string | null {
  if (action === 'screenshot') return 'PERFORMANCE'
  if (action === 'summary') return 'DAILY_SUMMARY'
  if (action === 'trade') return 'TRADES'
  return null
}
