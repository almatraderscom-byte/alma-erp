import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import type { TradingTelegramChat } from '@prisma/client'

/** Trim whitespace; preserve Telegram negative supergroup IDs. */
export function normalizeTelegramChatId(input: string): string {
  let id = String(input ?? '').trim().replace(/\s/g, '')
  if (!id) return id
  id = id.replace(/^['"]|['"]$/g, '')
  // Admin pasted positive group id — Telegram API uses negative for groups/supergroups.
  if (/^\d{6,}$/.test(id)) return `-${id}`
  return id
}

/** Candidate IDs for DB lookup (handles legacy positive storage and supergroup migration). */
export function telegramChatIdLookupVariants(chatId: string): string[] {
  const normalized = normalizeTelegramChatId(chatId)
  const raw = String(chatId ?? '').trim().replace(/\s/g, '')
  const variants = new Set<string>()

  if (raw) variants.add(raw)
  if (normalized) variants.add(normalized)

  if (normalized.startsWith('-100')) {
    variants.add(`-${normalized.slice(4)}`)
  } else if (/^-\d+$/.test(normalized) && !normalized.startsWith('-100')) {
    variants.add(`-100${normalized.slice(1)}`)
  }

  if (normalized.startsWith('-')) {
    variants.add(normalized.slice(1))
  }

  return [...variants].filter(Boolean)
}

function debugChatLookup(payload: {
  incomingChatId: string
  variants: string[]
  matched: TradingTelegramChat | null
}) {
  if (process.env.TELEGRAM_DEBUG_CHAT_LOOKUP !== 'true') return
  logEvent('info', 'trading.telegram.chat_lookup', {
    incomingChatId: payload.incomingChatId,
    lookupVariants: payload.variants,
    matched: Boolean(payload.matched),
    matchedChatId: payload.matched?.chatId ?? null,
    approved: payload.matched?.approved ?? null,
    businessId: TRADING_BUSINESS_ID,
  })
}

export async function findApprovedTelegramChat(
  incomingChatId: string,
): Promise<TradingTelegramChat | null> {
  const variants = telegramChatIdLookupVariants(incomingChatId)
  if (!variants.length) return null

  const matched = await prisma.tradingTelegramChat.findFirst({
    where: {
      businessId: TRADING_BUSINESS_ID,
      approved: true,
      chatId: { in: variants },
    },
  })

  debugChatLookup({ incomingChatId, variants, matched })

  // Canonicalize stored id when admin saved a legacy positive variant.
  if (matched && matched.chatId !== normalizeTelegramChatId(incomingChatId)) {
    const canonical = normalizeTelegramChatId(incomingChatId)
    if (canonical && canonical !== matched.chatId) {
      try {
        await prisma.tradingTelegramChat.update({
          where: { id: matched.id },
          data: { chatId: canonical },
        })
        return { ...matched, chatId: canonical }
      } catch {
        // Unique constraint if duplicate row exists — keep matched row as-is.
      }
    }
  }

  return matched
}

export async function touchTelegramChatSeen(chatRowId: string, title?: string | null) {
  await prisma.tradingTelegramChat.update({
    where: { id: chatRowId },
    data: {
      lastSeenAt: new Date(),
      ...(title ? { title } : {}),
    },
  })
}
