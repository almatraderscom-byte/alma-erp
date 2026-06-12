#!/usr/bin/env node
/**
 * Guards Telegram callback_data 64-byte limit (BUTTON_DATA_INVALID prevention).
 */
import {
  buildCallbackData,
  taskDoneCallbackData,
  parseTaskIdFromCallback,
  TELEGRAM_CALLBACK_MAX_BYTES,
} from '../src/telegram/callback-data.mjs'

const uuid = '8bd73fa2-1e09-4c5f-9ff9-8b47552a1d61'

// Old broken pattern: two UUIDs (83 bytes)
const legacy = `task_done:${uuid}:${uuid}`
if (legacy.length <= TELEGRAM_CALLBACK_MAX_BYTES) {
  throw new Error('legacy pattern should exceed 64 bytes')
}

const compact = taskDoneCallbackData(uuid)
if (compact.length > TELEGRAM_CALLBACK_MAX_BYTES) {
  throw new Error(`compact task_done too long: ${compact.length}`)
}
const restored = parseTaskIdFromCallback(compact.slice('task_done:'.length))
if (restored !== uuid) throw new Error(`UUID round-trip failed: ${restored}`)

buildCallbackData('msg_draft', 't_1648631293023028')

let threw = false
try {
  buildCallbackData('msg_draft', 't_' + '1'.repeat(80), 'page_' + '2'.repeat(40))
} catch (e) {
  threw = true
  if (!/exceeds Telegram max/.test(e.message)) throw e
}
if (!threw) throw new Error('expected buildCallbackData to throw on long payload')

console.log('✅ callback-data: compact task_done OK, legacy 2-UUID rejected, buildCallbackData guard works')
