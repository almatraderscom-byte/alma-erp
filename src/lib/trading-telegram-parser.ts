import type { TradingTradeType } from '@prisma/client'

export type ParsedTelegramCommand =
  | { kind: 'help' }
  | { kind: 'hide_keyboard' }
  | { kind: 'setaccount'; alias: string }
  | { kind: 'summary' }
  | { kind: 'undo' }
  | { kind: 'account' }
  | { kind: 'trade_hint'; tradeType: TradingTradeType }
  | { kind: 'trade'; alias: string | null; tradeType: TradingTradeType; usdtAmount: number; bdtRate: number; feeUsdt: number }
  | {
      kind: 'invalid'
      reason: string
      code: 'FORMAT' | 'FEE_MISSING' | 'AMOUNT' | 'RATE' | 'INCOMPLETE' | 'NO_DEFAULT'
      example?: string
      tradeType?: TradingTradeType
    }

const TRADE_SIDE: Record<string, TradingTradeType> = {
  b: 'BUY',
  buy: 'BUY',
  s: 'SELL',
  sell: 'SELL',
}

const KEYBOARD_ALIASES: Record<string, string> = {
  buy: 'buy',
  sell: 'sell',
  '/summary': '/summary',
  summary: '/summary',
  '/undo': '/undo',
  undo: '/undo',
  '/account': '/account',
  account: '/account',
  '/help': '/help',
  help: '/help',
  '/start': '/help',
  start: '/help',
  'hide keyboard': '/hide_keyboard',
  '/hide_keyboard': '/hide_keyboard',
}

function normalizeAlias(token: string): string {
  return token.trim().toLowerCase()
}

function isTradeSide(token: string): boolean {
  return token.toLowerCase() in TRADE_SIDE
}

/** Expand glued tokens: b500 → b 500, buy500 → buy 500 */
export function normalizeTelegramCommandText(raw: string): string {
  let text = raw.trim()
  const lower = text.toLowerCase()
  if (KEYBOARD_ALIASES[lower]) return KEYBOARD_ALIASES[lower]

  text = text.replace(/([a-z0-9_-]{1,16})(buy|sell|b|s)\b/gi, '$1 $2')
  text = text.replace(/\b(buy|sell|b|s)(\d)/gi, '$1 $2')

  return text.replace(/\s+/g, ' ').trim()
}

function parseNumbers(tokens: string[]): { usdt?: number; rate?: number; fee?: number } {
  const nums = tokens.map(t => Number(t.replace(/,/g, '')))
  return {
    usdt: nums[0],
    rate: nums[1],
    fee: nums[2],
  }
}

function incompleteTradeInvalid(
  tradeType: TradingTradeType,
  nums: string[],
  alias: string | null,
): Extract<ParsedTelegramCommand, { kind: 'invalid' }> {
  const side = tradeType === 'BUY' ? 'b' : 's'
  const prefix = alias ? `${alias} ${side}` : side
  const fullExample = `${prefix} 500 121.5 12`

  if (nums.length === 0) {
    return {
      kind: 'invalid',
      code: 'INCOMPLETE',
      reason: 'Amount, rate, and fee missing.',
      example: fullExample,
      tradeType,
    }
  }
  if (nums.length === 1) {
    return {
      kind: 'invalid',
      code: 'INCOMPLETE',
      reason: 'Rate and fee missing.',
      example: fullExample,
      tradeType,
    }
  }
  if (nums.length === 2) {
    return {
      kind: 'invalid',
      code: 'FEE_MISSING',
      reason: 'Fee missing.',
      example: fullExample,
      tradeType,
    }
  }

  return {
    kind: 'invalid',
    code: 'FORMAT',
    reason: 'Too many numbers. Use: amount, rate, fee',
    example: fullExample,
    tradeType,
  }
}

/**
 * User-isolated quick entry — no shift/session commands.
 * Flexible: b500 121.5 12 · buy 500 121.5 12 · sh buy 500 121.5 12
 */
export function parseTelegramTradeMessage(raw: string): ParsedTelegramCommand {
  const text = normalizeTelegramCommandText(raw)
  if (!text) return { kind: 'invalid', reason: 'Empty message', code: 'FORMAT' }

  const lower = text.toLowerCase()

  if (lower === '/help') return { kind: 'help' }
  if (lower === '/hide_keyboard') return { kind: 'hide_keyboard' }
  if (lower === '/summary') return { kind: 'summary' }
  if (lower === '/undo') return { kind: 'undo' }
  if (lower === '/account') return { kind: 'account' }

  if (lower === 'buy') return { kind: 'trade_hint', tradeType: 'BUY' }
  if (lower === 'sell') return { kind: 'trade_hint', tradeType: 'SELL' }

  const setMatch = text.match(/^\/?setaccount\s+([a-z0-9_-]{1,16})\s*$/i)
  if (setMatch) {
    return { kind: 'setaccount', alias: normalizeAlias(setMatch[1]) }
  }

  const tokens = text.split(/\s+/).filter(Boolean)

  let alias: string | null = null
  let sideIdx = 0

  if (tokens.length >= 2 && !isTradeSide(tokens[0]) && isTradeSide(tokens[1])) {
    alias = normalizeAlias(tokens[0])
    sideIdx = 1
  } else if (tokens.length >= 1 && isTradeSide(tokens[0])) {
    sideIdx = 0
  } else if (tokens.length >= 1 && !isTradeSide(tokens[0])) {
    if (/^\/?setaccount/i.test(text)) {
      return { kind: 'invalid', reason: 'Use: /setaccount sh', code: 'FORMAT', example: '/setaccount sh' }
    }
    return {
      kind: 'invalid',
      reason: 'Start with buy/sell (b or s) or account alias.',
      code: 'FORMAT',
      example: 'b 500 121.5 12 or sh b 500 121.5 12',
    }
  } else {
    return { kind: 'invalid', reason: 'Empty trade command', code: 'FORMAT', example: 'b 500 121.5 12' }
  }

  const sideToken = tokens[sideIdx]?.toLowerCase()
  const tradeType = TRADE_SIDE[sideToken]
  if (!tradeType) {
    return { kind: 'invalid', reason: 'Use b/buy or s/sell', code: 'FORMAT', example: 'b 500 121.5 12' }
  }

  const numTokens = tokens.slice(sideIdx + 1)
  if (numTokens.length < 3) {
    return incompleteTradeInvalid(tradeType, numTokens, alias)
  }

  const { usdt, rate, fee } = parseNumbers(numTokens.slice(0, 3))

  if (!Number.isFinite(usdt) || (usdt ?? 0) <= 0) {
    return {
      kind: 'invalid',
      code: 'AMOUNT',
      reason: 'USDT amount must be a positive number.',
      example: alias ? `${alias} ${sideToken} 500 121.5 12` : `${sideToken} 500 121.5 12`,
      tradeType,
    }
  }
  if (!Number.isFinite(rate) || (rate ?? 0) <= 0) {
    return {
      kind: 'invalid',
      code: 'RATE',
      reason: 'BDT rate must be a positive number.',
      example: alias ? `${alias} ${sideToken} 500 121.5 12` : `${sideToken} 500 121.5 12`,
      tradeType,
    }
  }
  if (!Number.isFinite(fee) || (fee ?? 0) < 0) {
    return {
      kind: 'invalid',
      code: 'FEE_MISSING',
      reason: 'Fee missing or invalid. Use 0 if no fee.',
      example: alias ? `${alias} ${sideToken} 500 121.5 12` : `${sideToken} 500 121.5 12`,
      tradeType,
    }
  }

  if (numTokens.length > 3) {
    return {
      kind: 'invalid',
      code: 'FORMAT',
      reason: 'Extra values after fee — use exactly 3 numbers.',
      example: alias ? `${alias} ${sideToken} 500 121.5 12` : `${sideToken} 500 121.5 12`,
      tradeType,
    }
  }

  return {
    kind: 'trade',
    alias,
    tradeType,
    usdtAmount: usdt!,
    bdtRate: rate!,
    feeUsdt: fee!,
  }
}

export function formatParsedTradeSummary(parsed: Extract<ParsedTelegramCommand, { kind: 'trade' }>): string {
  const side = parsed.tradeType === 'BUY' ? 'BUY' : 'SELL'
  return `${side} ${parsed.usdtAmount} USDT @ ${parsed.bdtRate} · fee ${parsed.feeUsdt}`
}
