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
let relaunchTimer = null
let relaunchAttempts = 0
let watchdogTimer = null
let lastPendingCount = 0

export function getTelegramBot() {
  return bot
}

/**
 * Self-heal the long-poller. Telegraf's getUpdates loop can die mid-run — most
 * often a transient "409 Conflict: terminated by other getUpdates" during a pm2
 * restart handoff, or a proxy/network blip. Before, launch().catch() just nulled
 * the bot and left polling dead forever while the process stayed alive (other
 * timers/HTTP servers keep it up) — so every Telegram button tap + message was
 * silently ignored until a manual pm2 restart (2026-07-14/15 incident). Now we
 * relaunch with backoff+jitter so a transient conflict self-corrects instead of
 * one side ping-ponging getUpdates forever.
 */
function scheduleRelaunch(reason) {
  if (isStopping || relaunchTimer) return
  relaunchAttempts += 1
  const base = Math.min(30_000, 5_000 * 2 ** Math.min(relaunchAttempts - 1, 3))
  const delay = base + Math.floor(Math.random() * 3_000)
  console.warn(`[telegram] poller down (${reason}) — relaunch in ${Math.round(delay / 1000)}s (attempt ${relaunchAttempts})`)
  relaunchTimer = setTimeout(async () => {
    relaunchTimer = null
    if (isStopping) return
    try {
      await launchTelegramBot()
      relaunchAttempts = 0
      console.log('[telegram] poller relaunched OK')
    } catch (e) {
      console.error('[telegram] relaunch failed:', e.message)
      scheduleRelaunch('relaunch-error')
    }
  }, delay)
}

/**
 * Belt-and-suspenders: a stalled poll doesn't always reject launch(). Every 60s,
 * ask Telegram how many updates are pending. If the backlog only grows across
 * consecutive checks, the loop is stuck consuming nothing — force a relaunch.
 */
function startWatchdog() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(async () => {
    if (isStopping || !isLaunched || !bot || relaunchTimer) return
    try {
      const info = await bot.telegram.getWebhookInfo()
      const pending = info?.pending_update_count ?? 0
      // Growing backlog on two straight checks = updates arriving but not consumed.
      if (pending >= 3 && pending >= lastPendingCount && lastPendingCount >= 3) {
        console.warn(`[telegram] watchdog: ${pending} updates pending & not draining — forcing relaunch`)
        try { bot.stop('watchdog') } catch { /* already down */ }
        bot = null
        isLaunched = false
        scheduleRelaunch('watchdog-stall')
      }
      lastPendingCount = pending
    } catch (err) {
      console.warn('[telegram] watchdog check failed:', err.message)
    }
  }, 60_000)
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
      // Do NOT leave polling dead — self-heal (was the 2026-07 buttons-dead bug).
      if (!isStopping) scheduleRelaunch(err.message)
    })

    // Verify bot is actually responsive before declaring it started
    try {
      const me = await instance.telegram.getMe()
      console.log(`[telegram] Bot verified: @${me.username} (id: ${me.id})`)
    } catch (verifyErr) {
      console.error('[telegram] Bot getMe() failed — bot may be dead:', verifyErr.message)
    }

    bot = instance
    isLaunched = true
    lastPendingCount = 0
    console.log('[telegram] Bot started (long-polling)')

    setDispatcherBot(bot, process.env.TELEGRAM_OWNER_CHAT_ID ?? '')
    startWatchdog()
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

  if (relaunchTimer) { clearTimeout(relaunchTimer); relaunchTimer = null }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }

  const instance = bot
  bot = null
  isLaunched = false

  try {
    instance.stop(signal)
    // Give Telegraf time to release the getUpdates long-poll before pm2 spawns a new process
    await new Promise((resolve) => setTimeout(resolve, 3000))
    console.log(`[telegram] Bot stopped (${signal})`)
  } catch (err) {
    console.error('[telegram] Bot stop error:', err.message)
  } finally {
    isStopping = false
  }
}
