/**
 * Singleton Telegraf launcher — prevents duplicate getUpdates polling (409 Conflict).
 * pm2 restart: SIGTERM/SIGINT must stop the bot before the new process launches.
 */

import { createTelegramBot } from './index.mjs'
import { setDispatcherBot } from './dispatcher.mjs'

let bot = null
let launchPromise = null
let isLaunched = false
let isStopping = false

export function getTelegramBot() {
  return bot
}

export async function launchTelegramBot() {
  if (!process.env.ASSISTANT_BOT_TOKEN) return null
  if (isLaunched && bot) return bot
  if (launchPromise) return launchPromise

  launchPromise = (async () => {
    console.log('[telegram] Bot initializing...')
    const instance = createTelegramBot()

    // Ensure polling mode — drop stale webhook updates from any prior instance
    await instance.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {})

    // launch() runs until stop() — must not await or the worker freezes on startup
    instance.launch({ dropPendingUpdates: true }).catch((err) => {
      console.error('[telegram] Polling ended:', err.message)
      bot = null
      isLaunched = false
    })

    bot = instance
    isLaunched = true
    console.log('[telegram] Bot started (long-polling)')

    setDispatcherBot(bot, process.env.TELEGRAM_OWNER_CHAT_ID ?? '')
    return bot
  })()

  try {
    return await launchPromise
  } catch (err) {
    bot = null
    isLaunched = false
    console.error('[telegram] Bot launch failed:', err.message)
    throw err
  } finally {
    launchPromise = null
  }
}

export async function stopTelegramBot(signal = 'shutdown') {
  if (!bot || isStopping) return
  isStopping = true

  const instance = bot
  bot = null
  isLaunched = false

  try {
    instance.stop(signal)
    // Give Telegraf time to release the getUpdates long-poll before pm2 spawns a new process
    await new Promise((resolve) => setTimeout(resolve, 1500))
    console.log(`[telegram] Bot stopped (${signal})`)
  } catch (err) {
    console.error('[telegram] Bot stop error:', err.message)
  } finally {
    isStopping = false
  }
}
