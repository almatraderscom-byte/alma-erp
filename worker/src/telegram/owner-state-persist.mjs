/**
 * Persist owner Telegram session to agent_kv_settings (survives PM2 restart).
 *
 * Telegram-only key, separate from the web/app pointer (`owner_web_state`). The
 * two channels never share a conversation: a Telegram message stays on the
 * Telegram daily session and never bleeds into the web/app thread, and vice
 * versa. (Old shared key `owner_telegram_state` is retired.)
 */
import { ownerState } from './owner-state.mjs'

const KV_KEY = 'owner_telegram_session'

export async function loadOwnerStateFromKv(supabase) {
  if (!supabase) return
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', KV_KEY)
      .maybeSingle()
    if (!data?.value) return
    const parsed = JSON.parse(data.value)
    if (parsed.conversationId) ownerState.conversationId = parsed.conversationId
    if (parsed.personalConversationId) ownerState.personalConversationId = parsed.personalConversationId
  } catch (err) {
    console.warn('[owner-state] load failed:', err.message)
  }
}

export async function persistOwnerStateToKv(supabase) {
  if (!supabase) return
  try {
    await supabase.from('agent_kv_settings').upsert({
      key: KV_KEY,
      value: JSON.stringify({
        conversationId: ownerState.conversationId,
        personalConversationId: ownerState.personalConversationId,
        updatedAt: new Date().toISOString(),
      }),
    })
  } catch (err) {
    console.warn('[owner-state] persist failed:', err.message)
  }
}
