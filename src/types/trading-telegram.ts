export type TradingTelegramDraftStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'POSTED'
  | 'FAILED'
  | 'UNDONE'
  | 'LOCKED'

export type TradingTelegramUserRow = {
  id: string
  telegramUserId: string
  telegramUsername?: string | null
  telegramFirstName?: string | null
  approved: boolean
  defaultAccountAlias?: string | null
  defaultTradingAccountId?: string | null
  userId?: string | null
  user?: {
    id: string
    name: string
    email?: string | null
    role?: string
    employeeIdGas?: string | null
    phone?: string | null
  } | null
  lastSeenAt?: string | null
}

export type TradingAccountAliasRow = {
  id: string
  alias: string
  active: boolean
  tradingAccountId: string
  tradingAccount?: { id: string; accountTitle: string; status: string }
}

export type TradingTelegramChatRow = {
  id: string
  chatId: string
  title?: string | null
  approved: boolean
  notes?: string | null
  lastSeenAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export type TradingTelegramDraftRow = {
  id: string
  status: TradingTelegramDraftStatus
  telegramUserId: string
  telegramUsername?: string | null
  telegramFirstName?: string | null
  userId?: string | null
  user?: { id: string; name: string; email?: string | null; profileImageUrl?: string | null } | null
  tradingAccountId?: string | null
  tradingAccount?: { id: string; accountTitle: string } | null
  accountAlias?: string | null
  accountTitle?: string | null
  rawMessage: string
  telegramMessageId?: string | null
  telegramChatId: string
  tradeType?: 'BUY' | 'SELL' | null
  usdtAmount?: number | string | null
  bdtRate?: number | string | null
  feeUsdt?: number | string | null
  parseError?: string | null
  tradingTradeId?: string | null
  rejectReason?: string | null
  tradeNumber?: number | null
  draftFingerprint?: string | null
  undoneAt?: string | null
  lockedAt?: string | null
  lockedReason?: string | null
  createdAt: string
}

export type TradingTelegramLiveDraft = {
  id: string
  status: string
  tradeNumber: number | null
  tradeType: string | null
  usdtAmount: unknown
  bdtRate: unknown
  feeUsdt: unknown
  accountTitle: string | null
  accountAlias: string | null
  telegramUsername: string | null
  telegramUserId: string
  draftFingerprint: string | null
  rawMessage: string
  createdAt: string
  user: { id: string; name: string; profileImageUrl?: string | null } | null
}

export type TradingTelegramLiveAudit = {
  id: string
  eventType: string
  telegramUserId: string | null
  telegramUsername: string | null
  rawMessage: string | null
  detail: string | null
  createdAt: string
}

export type TradingTelegramLiveFeed = {
  drafts: TradingTelegramLiveDraft[]
  audits: TradingTelegramLiveAudit[]
  counts: { pending: number; locked: number; rejected: number; posted: number; undone: number }
  serverTime: string
}

export type TradingTelegramDraftGroup = {
  key: {
    userId: string | null
    userName: string
    profileImageUrl?: string | null
    telegramUsername: string | null
    telegramUserId: string
    tradingAccountId: string | null
    accountTitle: string | null
    accountAlias: string | null
  }
  drafts: TradingTelegramDraftRow[]
}

export type TradingTelegramDraftDayGroup = {
  key: {
    ymd: string
    tradingAccountId: string | null
    accountTitle: string | null
    accountAlias: string | null
  }
  drafts: TradingTelegramDraftRow[]
}
