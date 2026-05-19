import type { TradingAccount, TradingTelegramUser } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { notifyRole } from '@/lib/notifications'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import {
  answerTelegramCallbackQuery,
  duplicateInlineKeyboard,
  editTelegramMessage,
  quickKeyboardMarkup,
  removeKeyboardMarkup,
  sendTelegramMessage,
  TELEGRAM_RESPONSES,
} from '@/lib/trading-telegram-bot'
import {
  formatParsedTradeSummary,
  parseTelegramTradeMessage,
  type ParsedTelegramCommand,
} from '@/lib/trading-telegram-parser'
import { lockStalePendingTelegramDrafts } from '@/lib/trading-telegram-lock'
import {
  clearPendingDuplicate,
  createPendingDuplicate,
  loadPendingDuplicate,
  purgeExpiredPendingDuplicates,
} from '@/lib/trading-telegram-pending-duplicate'
import { checkTelegramRateLimit } from '@/lib/trading-telegram-rate-limit'
import { findApprovedTelegramChat, touchTelegramChatSeen } from '@/lib/trading-telegram-chat'
import { logTelegramDraftAudit } from '@/lib/trading-telegram-draft-audit'
import {
  buildDraftFingerprint,
  buildUserTelegramDaySummary,
  findUserDuplicateDraft,
  nextTradeNumberForUser,
  undoLastUserDraft,
} from '@/lib/trading-telegram-user-ops'

export type { TelegramUpdate } from './trading-telegram-types'

import type { TelegramUpdate } from './trading-telegram-types'

type TelegramUserPayload = {
  id: number
  username?: string
  first_name?: string
  last_name?: string
}

type BotReply = {
  text: string
  keyboard?: 'show' | 'hide' | 'none'
  inlineDuplicateId?: string
}

async function logTelegramAudit(
  eventType: string,
  detail: {
    telegramUserId?: string
    telegramUsername?: string | null
    telegramChatId?: string
    rawMessage?: string
    detail?: string
  },
) {
  await prisma.tradingTelegramAuditLog.create({
    data: {
      businessId: TRADING_BUSINESS_ID,
      eventType,
      telegramUserId: detail.telegramUserId ?? null,
      telegramUsername: detail.telegramUsername ?? null,
      telegramChatId: detail.telegramChatId ?? null,
      rawMessage: detail.rawMessage ?? null,
      detail: detail.detail ?? null,
    },
  })
}

async function deliverBotReply(chatId: string, reply: BotReply) {
  if (reply.inlineDuplicateId) {
    await sendTelegramMessage(chatId, reply.text, {
      replyMarkup: duplicateInlineKeyboard(reply.inlineDuplicateId),
    })
    return
  }

  const replyMarkup =
    reply.keyboard === 'hide'
      ? removeKeyboardMarkup()
      : reply.keyboard === 'none'
        ? undefined
        : quickKeyboardMarkup()

  await sendTelegramMessage(chatId, reply.text, { replyMarkup })
}

async function alertSuperAdminUnknownUser(payload: {
  telegramUserId: string
  username?: string | null
  rawMessage: string
  chatId: string
}) {
  try {
    await notifyRole({
      role: 'SUPER_ADMIN',
      businessId: TRADING_BUSINESS_ID,
      type: 'ADMIN_ANNOUNCEMENT',
      priority: 'HIGH',
      title: 'Telegram quick-entry from unknown user',
      message: `@${payload.username || 'no-username'} (${payload.telegramUserId}): ${payload.rawMessage.slice(0, 120)}`,
      actionUrl: '/trading/telegram',
    })
  } catch {
    /* non-blocking */
  }
}

async function upsertTelegramProfile(from: TelegramUserPayload): Promise<TradingTelegramUser> {
  const telegramUserId = String(from.id)
  return prisma.tradingTelegramUser.upsert({
    where: { businessId_telegramUserId: { businessId: TRADING_BUSINESS_ID, telegramUserId } },
    create: {
      businessId: TRADING_BUSINESS_ID,
      telegramUserId,
      telegramUsername: from.username ?? null,
      telegramFirstName: from.first_name ?? null,
      telegramLastName: from.last_name ?? null,
      approved: false,
    },
    update: {
      telegramUsername: from.username ?? null,
      telegramFirstName: from.first_name ?? null,
      telegramLastName: from.last_name ?? null,
      lastSeenAt: new Date(),
    },
  })
}

async function resolveAliasRow(alias: string) {
  return prisma.tradingAccountAlias.findFirst({
    where: { businessId: TRADING_BUSINESS_ID, alias: alias.toLowerCase(), active: true },
    include: {
      tradingAccount: {
        select: { id: true, accountTitle: true, assignedUserId: true, deletedAt: true, status: true },
      },
    },
  })
}

async function staffCanUseAccount(link: TradingTelegramUser, account: Pick<TradingAccount, 'assignedUserId'>): Promise<boolean> {
  if (!link.approved || !link.userId) return false
  const user = await prisma.user.findFirst({
    where: { id: link.userId, active: true },
    select: { role: true },
  })
  if (!user) return false
  if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') return true
  if (!account.assignedUserId) return true
  return account.assignedUserId === link.userId
}

async function resolveAccountForTrade(
  link: TradingTelegramUser,
  alias: string | null,
): Promise<{ account: TradingAccount; alias: string | null } | { error: string; code?: 'UNKNOWN' | 'NO_DEFAULT' }> {
  if (alias) {
    const row = await resolveAliasRow(alias)
    if (!row?.tradingAccount || row.tradingAccount.deletedAt) {
      return { error: `Unknown account alias: ${alias}`, code: 'UNKNOWN' }
    }
    if (row.tradingAccount.status !== 'ACTIVE') {
      return { error: `Account ${row.tradingAccount.accountTitle} is not active.` }
    }
    if (!(await staffCanUseAccount(link, row.tradingAccount))) {
      return { error: 'You are not assigned to this trading account.' }
    }
    return { account: row.tradingAccount as TradingAccount, alias: row.alias }
  }

  if (link.defaultAccountAlias) {
    const row = await resolveAliasRow(link.defaultAccountAlias)
    if (row?.tradingAccount && !row.tradingAccount.deletedAt && row.tradingAccount.status === 'ACTIVE') {
      if (await staffCanUseAccount(link, row.tradingAccount)) {
        return { account: row.tradingAccount as TradingAccount, alias: row.alias }
      }
    }
  }

  if (link.defaultTradingAccountId) {
    const account = await prisma.tradingAccount.findFirst({
      where: {
        id: link.defaultTradingAccountId,
        businessId: TRADING_BUSINESS_ID,
        deletedAt: null,
        status: 'ACTIVE',
      },
    })
    if (account && (await staffCanUseAccount(link, account))) {
      return { account, alias: link.defaultAccountAlias }
    }
  }

  return {
    error: 'No default account. Use /setaccount <alias> or prefix: sh b 500 121.5 12',
    code: 'NO_DEFAULT',
  }
}

async function getUserDefaultAccountDisplay(link: TradingTelegramUser) {
  if (link.defaultTradingAccountId) {
    const acc = await prisma.tradingAccount.findFirst({
      where: { id: link.defaultTradingAccountId },
      select: { accountTitle: true },
    })
    return { title: acc?.accountTitle ?? null, alias: link.defaultAccountAlias ?? null }
  }
  return { title: null, alias: link.defaultAccountAlias ?? null }
}

async function createDraft(params: {
  link: TradingTelegramUser
  account: TradingAccount
  alias: string | null
  parsed: Extract<ParsedTelegramCommand, { kind: 'trade' }>
  rawMessage: string
  messageId: number
  chatId: string
  tradeNumber: number
  draftFingerprint: string
}) {
  return prisma.tradingTelegramDraft.create({
    data: {
      businessId: TRADING_BUSINESS_ID,
      status: 'PENDING',
      inputChannel: 'TEXT_COMMAND',
      telegramUserId: params.link.telegramUserId,
      telegramUsername: params.link.telegramUsername,
      telegramFirstName: params.link.telegramFirstName,
      userId: params.link.userId,
      tradingAccountId: params.account.id,
      accountAlias: params.alias,
      accountTitle: params.account.accountTitle,
      rawMessage: params.rawMessage,
      telegramMessageId: String(params.messageId),
      telegramChatId: params.chatId,
      tradeType: params.parsed.tradeType,
      usdtAmount: params.parsed.usdtAmount,
      bdtRate: params.parsed.bdtRate,
      feeUsdt: params.parsed.feeUsdt,
      tradeNumber: params.tradeNumber,
      draftFingerprint: params.draftFingerprint,
    },
  })
}

async function persistTradeDraft(params: {
  link: TradingTelegramUser
  account: TradingAccount
  alias: string | null
  parsed: Extract<ParsedTelegramCommand, { kind: 'trade' }>
  rawMessage: string
  messageId: number
  chatId: string
}): Promise<BotReply> {
  const fingerprint = buildDraftFingerprint({
    tradeType: params.parsed.tradeType,
    usdtAmount: params.parsed.usdtAmount,
    bdtRate: params.parsed.bdtRate,
    feeUsdt: params.parsed.feeUsdt,
    tradingAccountId: params.account.id,
  })

  const tradeNumber = await nextTradeNumberForUser(params.link.telegramUserId)
  const summary = formatParsedTradeSummary(params.parsed)

  const draft = await createDraft({
    ...params,
    tradeNumber,
    draftFingerprint: fingerprint,
  })

  if (params.link.userId) {
    await logTelegramDraftAudit({
      eventType: 'DRAFT_CREATED',
      draftId: draft.id,
      actorUserId: params.link.userId,
      telegramUserId: params.link.telegramUserId,
      telegramChatId: params.chatId,
    })
  }

  logEvent('info', 'trading.telegram.draft_created', {
    telegramUserId: params.link.telegramUserId,
    accountId: params.account.id,
    tradeType: params.parsed.tradeType,
    usdt: params.parsed.usdtAmount,
    tradeNumber,
  })

  return {
    text: TELEGRAM_RESPONSES.tradeSaved(tradeNumber, params.account.accountTitle, summary),
    keyboard: 'show',
  }
}

async function handleParsedCommand(
  parsed: ParsedTelegramCommand,
  ctx: {
    link: TradingTelegramUser
    rawMessage: string
    messageId: number
    chatId: string
  },
): Promise<BotReply> {
  const { link, rawMessage, messageId, chatId } = ctx

  if (parsed.kind === 'help') {
    return { text: TELEGRAM_RESPONSES.help, keyboard: 'show' }
  }

  if (parsed.kind === 'hide_keyboard') {
    return { text: '⌨️ Keyboard hidden. Send /help to show it again.', keyboard: 'hide' }
  }

  if (parsed.kind === 'trade_hint') {
    return { text: TELEGRAM_RESPONSES.tradeHint(parsed.tradeType), keyboard: 'show' }
  }

  if (parsed.kind === 'account') {
    const acct = await getUserDefaultAccountDisplay(link)
    return { text: TELEGRAM_RESPONSES.accountInfo(acct.title, acct.alias), keyboard: 'show' }
  }

  if (parsed.kind === 'invalid') {
    await logTelegramAudit(parsed.code === 'FEE_MISSING' ? 'FEE_MISSING' : 'INVALID_FORMAT', {
      telegramUserId: link.telegramUserId,
      telegramChatId: chatId,
      rawMessage,
      detail: parsed.reason,
    })
    return {
      text: TELEGRAM_RESPONSES.partialCommand(parsed.reason, parsed.example),
      keyboard: 'show',
    }
  }

  if (parsed.kind === 'summary') {
    const summary = await buildUserTelegramDaySummary(link.telegramUserId)
    return { text: TELEGRAM_RESPONSES.summary(summary), keyboard: 'show' }
  }

  if (parsed.kind === 'undo') {
    const undone = await undoLastUserDraft(link.telegramUserId)
    if (!undone) return { text: TELEGRAM_RESPONSES.undoFail, keyboard: 'show' }
    const summary = formatParsedTradeSummary({
      kind: 'trade',
      alias: null,
      tradeType: undone.tradeType!,
      usdtAmount: Number(undone.usdtAmount),
      bdtRate: Number(undone.bdtRate),
      feeUsdt: Number(undone.feeUsdt ?? 0),
    })
    await logTelegramAudit('UNDO', {
      telegramUserId: link.telegramUserId,
      telegramChatId: chatId,
      rawMessage,
      detail: `Undid draft ${undone.id} #${undone.tradeNumber}`,
    })
    return { text: TELEGRAM_RESPONSES.undoOk(undone.tradeNumber, summary), keyboard: 'show' }
  }

  if (parsed.kind === 'setaccount') {
    const row = await resolveAliasRow(parsed.alias)
    if (!row?.tradingAccount || row.tradingAccount.deletedAt) {
      return { text: TELEGRAM_RESPONSES.setAccountFail(parsed.alias), keyboard: 'show' }
    }
    if (!(await staffCanUseAccount(link, row.tradingAccount))) {
      return { text: TELEGRAM_RESPONSES.forbiddenAccount, keyboard: 'show' }
    }
    await prisma.tradingTelegramUser.update({
      where: { id: link.id },
      data: {
        defaultAccountAlias: parsed.alias,
        defaultTradingAccountId: row.tradingAccount.id,
      },
    })
    return { text: TELEGRAM_RESPONSES.setAccountOk(parsed.alias, row.tradingAccount.accountTitle), keyboard: 'show' }
  }

  const accountResult = await resolveAccountForTrade(link, parsed.alias)
  if ('error' in accountResult) {
    if (accountResult.code === 'UNKNOWN' && parsed.alias) {
      await logTelegramAudit('UNKNOWN_ACCOUNT', {
        telegramUserId: link.telegramUserId,
        telegramChatId: chatId,
        rawMessage,
        detail: accountResult.error,
      })
      return { text: TELEGRAM_RESPONSES.unknownAccount(parsed.alias), keyboard: 'show' }
    }
    if (accountResult.code === 'NO_DEFAULT') {
      return {
        text: TELEGRAM_RESPONSES.partialCommand(
          'No default account selected.',
          '/setaccount sh',
        ),
        keyboard: 'show',
      }
    }
    return {
      text: TELEGRAM_RESPONSES.partialCommand(accountResult.error),
      keyboard: 'show',
    }
  }

  const { account, alias } = accountResult

  const fingerprint = buildDraftFingerprint({
    tradeType: parsed.tradeType,
    usdtAmount: parsed.usdtAmount,
    bdtRate: parsed.bdtRate,
    feeUsdt: parsed.feeUsdt,
    tradingAccountId: account.id,
  })

  const duplicate = await findUserDuplicateDraft(link.telegramUserId, fingerprint)
  if (duplicate) {
    await logTelegramAudit('DUPLICATE_TRADE', {
      telegramUserId: link.telegramUserId,
      telegramChatId: chatId,
      rawMessage,
      detail: `Matches #${duplicate.tradeNumber}`,
    })

    const pending = await createPendingDuplicate({
      telegramUserId: link.telegramUserId,
      telegramChatId: chatId,
      rawMessage,
      payload: {
        parsed: {
          tradeType: parsed.tradeType,
          usdtAmount: parsed.usdtAmount,
          bdtRate: parsed.bdtRate,
          feeUsdt: parsed.feeUsdt,
          alias: parsed.alias,
        },
        accountId: account.id,
        accountTitle: account.accountTitle,
        alias,
        fingerprint,
        messageId,
      },
    })

    return {
      text: TELEGRAM_RESPONSES.duplicatePrompt({
        tradeNo: duplicate.tradeNumber,
        at: duplicate.createdAt,
        accountTitle: duplicate.accountTitle,
        accountAlias: duplicate.accountAlias,
      }),
      keyboard: 'none',
      inlineDuplicateId: pending.id,
    }
  }

  return persistTradeDraft({
    link,
    account,
    alias,
    parsed,
    rawMessage,
    messageId,
    chatId,
  })
}

async function handleDuplicateCallback(
  data: string,
  from: TelegramUserPayload,
  chatId: string,
  callbackQueryId: string,
  messageId?: number,
) {
  const match = data.match(/^dup:(ok|no):(.+)$/)
  if (!match) {
    await answerTelegramCallbackQuery(callbackQueryId, 'Unknown action')
    return
  }

  const [, action, pendingId] = match
  const telegramUserId = String(from.id)
  const link = await prisma.tradingTelegramUser.findFirst({
    where: { businessId: TRADING_BUSINESS_ID, telegramUserId, approved: true },
  })

  if (!link?.userId) {
    await answerTelegramCallbackQuery(callbackQueryId, 'Unauthorized')
    return
  }

  const loaded = await loadPendingDuplicate(pendingId, telegramUserId)
  if (!loaded) {
    await answerTelegramCallbackQuery(callbackQueryId, 'Expired — send the trade again')
    if (messageId) {
      await editTelegramMessage(chatId, messageId, '⚠️ Duplicate prompt expired. Send trade again.')
    }
    return
  }

  const { row, payload } = loaded

  if (action === 'no') {
    await clearPendingDuplicate(row.id)
    await logTelegramAudit('DUPLICATE_CANCELLED', {
      telegramUserId,
      telegramChatId: chatId,
      rawMessage: row.rawMessage,
    })
    await answerTelegramCallbackQuery(callbackQueryId, 'Cancelled')
    if (messageId) {
      await editTelegramMessage(chatId, messageId, TELEGRAM_RESPONSES.duplicateCancelled)
    }
    return
  }

  const account = await prisma.tradingAccount.findFirst({
    where: { id: payload.accountId, businessId: TRADING_BUSINESS_ID, deletedAt: null },
  })
  if (!account) {
    await answerTelegramCallbackQuery(callbackQueryId, 'Account unavailable')
    return
  }

  const parsed: Extract<ParsedTelegramCommand, { kind: 'trade' }> = {
    kind: 'trade',
    alias: payload.parsed.alias,
    tradeType: payload.parsed.tradeType,
    usdtAmount: payload.parsed.usdtAmount,
    bdtRate: payload.parsed.bdtRate,
    feeUsdt: payload.parsed.feeUsdt,
  }

  const tradeNumber = await nextTradeNumberForUser(telegramUserId)
  const summary = formatParsedTradeSummary(parsed)

  await createDraft({
    link,
    account,
    alias: payload.alias,
    parsed,
    rawMessage: row.rawMessage,
    messageId: payload.messageId,
    chatId,
    tradeNumber,
    draftFingerprint: payload.fingerprint,
  })

  await clearPendingDuplicate(row.id)
  await logTelegramAudit('DUPLICATE_SAVED', {
    telegramUserId,
    telegramChatId: chatId,
    rawMessage: row.rawMessage,
    detail: `Saved anyway as #${tradeNumber}`,
  })

  await answerTelegramCallbackQuery(callbackQueryId, `Saved #${tradeNumber}`)
  if (messageId) {
    await editTelegramMessage(
      chatId,
      messageId,
      TELEGRAM_RESPONSES.duplicateSaved(tradeNumber, summary),
    )
  }
}

const ALLOWED_CHAT_TYPES = new Set(['group', 'supergroup', 'private'])

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    const cq = update.callback_query
    if (!cq.data || !cq.from) return
    const chatId = cq.message?.chat.id
    if (!chatId) return
    const { handlePenaltyAppealTelegramCallback } = await import('@/lib/penalty-appeal-callback')
    if (await handlePenaltyAppealTelegramCallback(cq.data, String(chatId), cq.id, String(cq.from.id))) return
    const { handleVolumeTargetTelegramCallback } = await import('@/lib/trading-volume-target-callback')
    if (await handleVolumeTargetTelegramCallback(cq.data, String(chatId), cq.id, String(cq.from.id))) return
    await purgeExpiredPendingDuplicates()
    await handleDuplicateCallback(cq.data, cq.from, String(chatId), cq.id, cq.message?.message_id)
    return
  }

  const message = update.message
  if (!message?.text || !message.from) return
  if (!ALLOWED_CHAT_TYPES.has(message.chat.type)) return

  const chatId = String(message.chat.id)
  const rawMessage = message.text.trim()
  const from = message.from

  const approvedChat = await findApprovedTelegramChat(chatId)
  if (!approvedChat) {
    await logTelegramAudit('UNKNOWN_CHAT', {
      telegramChatId: chatId,
      rawMessage,
      detail: `${message.chat.title ?? message.chat.type}; lookup failed`,
    })
    await deliverBotReply(chatId, { text: TELEGRAM_RESPONSES.unknownChat(chatId), keyboard: 'none' })
    return
  }

  void touchTelegramChatSeen(approvedChat.id, message.chat.title)

  const rate = checkTelegramRateLimit(String(from.id), chatId)
  if (!rate.allowed) {
    await logTelegramAudit('RATE_LIMIT', {
      telegramUserId: String(from.id),
      telegramUsername: from.username,
      telegramChatId: chatId,
      rawMessage,
    })
    await deliverBotReply(chatId, { text: TELEGRAM_RESPONSES.rateLimited(rate.retryAfterSec ?? 30), keyboard: 'show' })
    return
  }

  await purgeExpiredPendingDuplicates()
  void lockStalePendingTelegramDrafts()

  const link = await upsertTelegramProfile(from)

  if (!link.approved || !link.userId) {
    await logTelegramAudit('UNAUTHORIZED_USER', {
      telegramUserId: link.telegramUserId,
      telegramUsername: link.telegramUsername,
      telegramChatId: chatId,
      rawMessage,
    })
    await alertSuperAdminUnknownUser({
      telegramUserId: link.telegramUserId,
      username: link.telegramUsername,
      rawMessage,
      chatId,
    })
    await deliverBotReply(chatId, { text: TELEGRAM_RESPONSES.unauthorized, keyboard: 'none' })
    return
  }

  const erpUser = await prisma.user.findFirst({
    where: { id: link.userId, active: true },
    select: { id: true },
  })
  if (!erpUser) {
    await deliverBotReply(chatId, { text: TELEGRAM_RESPONSES.unauthorized, keyboard: 'none' })
    return
  }

  const parsed = parseTelegramTradeMessage(rawMessage)
  const reply = await handleParsedCommand(parsed, {
    link,
    rawMessage,
    messageId: message.message_id,
    chatId,
  })

  await deliverBotReply(chatId, reply)
}
