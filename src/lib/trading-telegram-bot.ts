const TELEGRAM_API = 'https://api.telegram.org'

/** Hard cap for any single Telegram API HTTP request. Prevents queue-batch hangs. */
const TELEGRAM_FETCH_TIMEOUT_MS = 12_000

export function getTelegramBotToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined
}

async function fetchTelegramWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = TELEGRAM_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function describeTelegramFetchError(err: unknown): { message: string; code: number } {
  const e = err as Error
  if (e?.name === 'AbortError') return { message: 'telegram_api_timeout', code: 408 }
  return { message: e?.message || 'telegram_api_network_error', code: 0 }
}

export type TelegramInlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }

export type TelegramSendOptions = {
  replyMarkup?: {
    keyboard?: string[][]
    resize_keyboard?: boolean
    one_time_keyboard?: boolean
    remove_keyboard?: boolean
    inline_keyboard?: TelegramInlineButton[][]
  }
}

export const TELEGRAM_QUICK_KEYBOARD: string[][] = [
  ['BUY', 'SELL'],
  ['/summary', '/undo'],
  ['/account', '/help'],
  ['Hide keyboard'],
]

export type TelegramSendResult = {
  ok: boolean
  messageId?: number
  errorMessage?: string
  errorCode?: number
}

type TelegramApiResponse = {
  ok: boolean
  description?: string
  error_code?: number
  result?: { message_id: number }
}

function parseTelegramError(data: TelegramApiResponse, fallback: string): string {
  const parts = [data.error_code ? String(data.error_code) : null, data.description || fallback].filter(Boolean)
  return parts.join(': ').slice(0, 500)
}

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  options?: TelegramSendOptions,
): Promise<TelegramSendResult> {
  const token = getTelegramBotToken()
  if (!token) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN not configured')
    return { ok: false, errorMessage: 'TELEGRAM_BOT_TOKEN_MISSING' }
  }
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }
    if (options?.replyMarkup) body.reply_markup = options.replyMarkup

    const res = await fetchTelegramWithTimeout(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as TelegramApiResponse
    if (!res.ok || !data.ok) {
      const err = parseTelegramError(data, await res.text().catch(() => 'sendMessage failed'))
      console.error('[telegram] sendMessage failed', chatId, err.slice(0, 200))
      return { ok: false, errorMessage: err, errorCode: data.error_code }
    }
    return { ok: true, messageId: data.result?.message_id }
  } catch (e) {
    const info = describeTelegramFetchError(e)
    console.error('[telegram] sendMessage error', info.message)
    return { ok: false, errorMessage: info.message, errorCode: info.code || undefined }
  }
}

export async function sendTelegramPhoto(
  chatId: string | number,
  photoUrl: string,
  caption: string,
): Promise<TelegramSendResult> {
  const token = getTelegramBotToken()
  if (!token) return { ok: false, errorMessage: 'TELEGRAM_BOT_TOKEN_MISSING' }
  try {
    const res = await fetchTelegramWithTimeout(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption.slice(0, 1024),
        parse_mode: 'HTML',
      }),
    })
    const data = (await res.json()) as TelegramApiResponse
    if (!res.ok || !data.ok) {
      const err = parseTelegramError(data, 'sendPhoto failed')
      console.error('[telegram] sendPhoto url failed', chatId, err.slice(0, 200))
      return { ok: false, errorMessage: err, errorCode: data.error_code }
    }
    return { ok: true, messageId: data.result?.message_id }
  } catch (e) {
    const info = describeTelegramFetchError(e)
    return { ok: false, errorMessage: info.message, errorCode: info.code || undefined }
  }
}

export async function sendTelegramPhotoBuffer(
  chatId: string | number,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  caption: string,
): Promise<TelegramSendResult> {
  const token = getTelegramBotToken()
  if (!token) return { ok: false, errorMessage: 'TELEGRAM_BOT_TOKEN_MISSING' }
  try {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('caption', caption.slice(0, 1024))
    form.append('parse_mode', 'HTML')
    const blob = new Blob([buffer], { type: mimeType || 'image/webp' })
    form.append('photo', blob, fileName || 'screenshot.webp')

    const res = await fetchTelegramWithTimeout(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
    })
    const data = (await res.json()) as TelegramApiResponse
    if (!res.ok || !data.ok) {
      const err = parseTelegramError(data, 'sendPhoto buffer failed')
      console.error('[telegram] sendPhoto buffer failed', chatId, err.slice(0, 200))
      return { ok: false, errorMessage: err, errorCode: data.error_code }
    }
    return { ok: true, messageId: data.result?.message_id }
  } catch (e) {
    const info = describeTelegramFetchError(e)
    return { ok: false, errorMessage: info.message, errorCode: info.code || undefined }
  }
}

export type TelegramMediaItem = {
  buffer: Buffer
  fileName: string
  mimeType: string
  caption?: string
}

/** Up to 10 photos; caption only on the last item (Telegram rule). */
export async function sendTelegramMediaGroup(
  chatId: string | number,
  items: TelegramMediaItem[],
): Promise<TelegramSendResult> {
  const token = getTelegramBotToken()
  if (!token) return { ok: false, errorMessage: 'TELEGRAM_BOT_TOKEN_MISSING' }
  if (!items.length) return { ok: false, errorMessage: 'empty_media_group' }

  try {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    const media = items.map((item, index) => {
      const attach = `file${index}`
      const entry: Record<string, string> = {
        type: 'photo',
        media: `attach://${attach}`,
      }
      if (index === items.length - 1 && item.caption) {
        entry.caption = item.caption.slice(0, 1024)
        entry.parse_mode = 'HTML'
      }
      return entry
    })
    form.append('media', JSON.stringify(media))
    items.forEach((item, index) => {
      const blob = new Blob([item.buffer], { type: item.mimeType || 'image/webp' })
      form.append(`file${index}`, blob, item.fileName || `photo-${index}.webp`)
    })

    const res = await fetchTelegramWithTimeout(`${TELEGRAM_API}/bot${token}/sendMediaGroup`, {
      method: 'POST',
      body: form,
    })
    const data = (await res.json()) as TelegramApiResponse
    if (!res.ok || !data.ok) {
      const err = parseTelegramError(data, 'sendMediaGroup failed')
      console.error('[telegram] sendMediaGroup failed', chatId, err.slice(0, 200))
      return { ok: false, errorMessage: err, errorCode: data.error_code }
    }
    return { ok: true, messageId: data.result?.message_id }
  } catch (e) {
    const info = describeTelegramFetchError(e)
    return { ok: false, errorMessage: info.message, errorCode: info.code || undefined }
  }
}

export async function answerTelegramCallbackQuery(callbackQueryId: string, text?: string) {
  const token = getTelegramBotToken()
  if (!token) return false
  try {
    const res = await fetchTelegramWithTimeout(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text?.slice(0, 200),
        show_alert: Boolean(text && text.length > 60),
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function editTelegramMessage(
  chatId: string | number,
  messageId: number,
  text: string,
) {
  const token = getTelegramBotToken()
  if (!token) return false
  try {
    const res = await fetchTelegramWithTimeout(`${TELEGRAM_API}/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

export function quickKeyboardMarkup(): TelegramSendOptions['replyMarkup'] {
  return {
    keyboard: TELEGRAM_QUICK_KEYBOARD,
    resize_keyboard: true,
  }
}

export function removeKeyboardMarkup(): TelegramSendOptions['replyMarkup'] {
  return { remove_keyboard: true }
}

export function duplicateInlineKeyboard(pendingId: string): TelegramSendOptions['replyMarkup'] {
  return {
    inline_keyboard: [
      [
        { text: 'Save anyway', callback_data: `dup:ok:${pendingId}` },
        { text: 'Cancel', callback_data: `dup:no:${pendingId}` },
      ],
    ],
  }
}

export async function registerTelegramWebhook(webhookUrl: string, secretToken: string) {
  const token = getTelegramBotToken()
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured')

  const res = await fetchTelegramWithTimeout(`${TELEGRAM_API}/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    }),
  })
  const data = (await res.json()) as { ok: boolean; description?: string }
  if (!data.ok) throw new Error(data.description || 'setWebhook failed')
  return data
}

export async function getTelegramWebhookInfo() {
  const token = getTelegramBotToken()
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured')
  const res = await fetchTelegramWithTimeout(`${TELEGRAM_API}/bot${token}/getWebhookInfo`, {
    method: 'GET',
  })
  return res.json() as Promise<{ ok: boolean; result?: Record<string, unknown> }>
}

function formatBdTime(d: Date): string {
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
}

export const TELEGRAM_RESPONSES = {
  tradeSaved: (tradeNo: number, account: string, summary: string) =>
    `✅ <b>Trade saved</b> #${tradeNo}\n${account}\n${summary}\n<i>Pending ERP confirm — ledger unchanged until approved.</i>`,
  tradeHint: (tradeType: 'BUY' | 'SELL') => {
    const side = tradeType === 'BUY' ? 'b' : 's'
    return `📝 <b>${tradeType}</b>\nSend:\n<code>${side} 500 121.5 12</code>\n(amount · rate · fee)`
  },
  accountInfo: (title: string | null, alias: string | null) => {
    if (!title) return 'ℹ️ <b>Current account</b>\nNo default account selected.\nUse <code>/setaccount sh</code>'
    const aliasPart = alias ? ` (<code>${alias}</code>)` : ''
    return `ℹ️ <b>Current account</b>\n${title}${aliasPart}`
  },
  partialCommand: (reason: string, example?: string) => {
    const ex = example ? `\n\nExample:\n<code>${example}</code>` : ''
    return `❌ ${reason}${ex}`
  },
  unknownAccount: (alias: string) => `❌ <b>Unknown account</b>: <code>${alias}</code>`,
  noDefaultAccount:
    '❌ <b>No default account</b>\nUse <code>/setaccount sh</code> or prefix: <code>sh b 500 121.5 12</code>',
  unauthorized: '❌ <b>Unauthorized user</b>\nAsk admin to link your Telegram to Alma ERP.',
  forbiddenAccount: '❌ <b>Account not allowed</b>\nYou are not assigned to this trading account.',
  rateLimited: (sec: number) => `❌ <b>Too many messages</b>\nWait ${sec}s and try again.`,
  unknownChat: (chatId: string) =>
    `❌ <b>Group not registered</b>\nChat ID: <code>${chatId}</code>\nAdmin: ERP → Trading → Telegram → Groups.`,
  setAccountOk: (alias: string, title: string) => `✅ Default account: <code>${alias}</code> → ${title}`,
  setAccountFail: (alias: string) => `❌ Unknown account: <code>${alias}</code>`,
  duplicatePrompt: (p: {
    tradeNo: number | null
    at: Date
    accountTitle: string | null
    accountAlias: string | null
  }) => {
    const acct = p.accountTitle || p.accountAlias || '—'
    const alias = p.accountAlias ? ` (<code>${p.accountAlias}</code>)` : ''
    return `⚠️ <b>Possible duplicate trade</b>

Previous: <b>#${p.tradeNo ?? '?'}</b>
Time: ${formatBdTime(p.at)}
Account: ${acct}${alias}

Save anyway or cancel?`
  },
  duplicateCancelled: '❌ Duplicate save cancelled.',
  duplicateSaved: (tradeNo: number, summary: string) =>
    `✅ <b>Saved anyway</b> #${tradeNo}\n${summary}`,
  undoOk: (tradeNo: number | null, summary: string) =>
    `↩️ <b>Undone</b> #${tradeNo ?? '?'}\n${summary}`,
  undoFail: '❌ <b>Nothing to undo</b>\nNo pending trade from you.',
  summary: (s: {
    ymd: string
    tradeCount: number
    buyVolumeUsdt: number
    sellVolumeUsdt: number
    feesBdt: number
    pendingDrafts: number
    estimatedPlBdt: number
    defaultAccountTitle: string | null
    defaultAccountAlias: string | null
  }) => {
    const plSign = s.estimatedPlBdt >= 0 ? '+' : ''
    const acct = s.defaultAccountTitle
      ? `${s.defaultAccountAlias ? `${s.defaultAccountAlias} → ` : ''}${s.defaultAccountTitle}`
      : 'Not set — use /setaccount'
    return `📊 <b>Today's Summary</b> (${s.ymd})
<i>Your activity only</i>

Trades: <b>${s.tradeCount}</b>
BUY volume: <b>${s.buyVolumeUsdt}</b> USDT
SELL volume: <b>${s.sellVolumeUsdt}</b> USDT
Fees (today): <b>${s.feesBdt}</b> BDT
Pending drafts: <b>${s.pendingDrafts}</b>
Est. P/L (drafts): <b>${plSign}${s.estimatedPlBdt}</b> BDT

Default account: ${acct}`
  },
  help: `📋 <b>Alma Trading Quick Entry</b>
<i>Per-user · no shared shift</i>

<b>Buy:</b> <code>b 500 121.5 12</code> or <code>b500 121.5 12</code>
<b>Sell:</b> <code>s 300 122 5</code>

<b>Account:</b> <code>/setaccount sh</code> · <code>/account</code>
<b>Stats:</b> <code>/summary</code> · <b>Undo:</b> <code>/undo</code>

Use the keyboard below for quick actions.`,
} as const
