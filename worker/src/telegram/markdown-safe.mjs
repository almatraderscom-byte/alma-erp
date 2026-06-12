/**
 * Telegram legacy Markdown breaks on unescaped `_` / `*` in dynamic text (e.g. t_1648631293023028).
 * Try Markdown first; on entity parse errors, retry plain text (keep reply_markup).
 */

function isMarkdownParseError(err) {
  const msg = String(err?.message ?? err ?? '')
  return /parse entities|can't find end of the entity/i.test(msg)
}

/**
 * @param {import('telegraf').Context} ctx
 * @param {string} text
 * @param {import('telegraf/types').ExtraReplyMessage} [extra]
 */
export async function replyMarkdownSafe(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, { ...extra, parse_mode: 'Markdown' })
  } catch (err) {
    if (!isMarkdownParseError(err)) throw err
    console.warn('[telegram] Markdown parse failed, retrying plain text:', err.message)
    const { parse_mode: _pm, ...rest } = extra
    return await ctx.reply(text, rest)
  }
}

/**
 * @param {import('telegraf').Telegram} telegram
 * @param {number|string} chatId
 * @param {string} text
 * @param {import('telegraf/types').ExtraReplyMessage} [extra]
 */
export async function sendMarkdownSafe(telegram, chatId, text, extra = {}) {
  try {
    return await telegram.sendMessage(chatId, text, { ...extra, parse_mode: 'Markdown' })
  } catch (err) {
    if (!isMarkdownParseError(err)) throw err
    console.warn('[telegram] Markdown parse failed, retrying plain text:', err.message)
    const { parse_mode: _pm, ...rest } = extra
    return await telegram.sendMessage(chatId, text, rest)
  }
}
