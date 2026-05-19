const PREFIX = 'alma-trading-draft:'

export type TradingTradeDraft = {
  tradingAccountId: string
  entryMode: 'BKASH' | 'BANK'
  form: { tradeType: 'BUY' | 'SELL'; usdtAmount: string; bdtRate: string; feeUsdt: string; notes: string }
  bkashForm: { summaryDate: string; totalProfitBdt: string; totalLossBdt: string; notes: string }
  savedAt: string
}

export type TradingSummaryDraft = {
  tradingAccountId: string
  summaryDate: string
  totalOrders: string
  totalProfitBdt: string
  totalLossBdt: string
  notes: string
  savedAt: string
}

export type TradingScreenshotDraft = {
  accountId: string
  shotDate: string
  note: string
  savedAt: string
}

function read<T>(key: string): T | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}`)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function write<T>(key: string, value: T) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(`${PREFIX}${key}`, JSON.stringify(value))
}

function remove(key: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(`${PREFIX}${key}`)
}

export const tradingDrafts = {
  trade: {
    load: () => read<TradingTradeDraft>('trade'),
    save: (draft: TradingTradeDraft) => write('trade', { ...draft, savedAt: new Date().toISOString() }),
    clear: () => remove('trade'),
  },
  summary: {
    load: () => read<TradingSummaryDraft>('summary'),
    save: (draft: TradingSummaryDraft) => write('summary', { ...draft, savedAt: new Date().toISOString() }),
    clear: () => remove('summary'),
  },
  screenshot: {
    load: () => read<TradingScreenshotDraft>('screenshot'),
    save: (draft: TradingScreenshotDraft) => write('screenshot', { ...draft, savedAt: new Date().toISOString() }),
    clear: () => remove('screenshot'),
  },
}
