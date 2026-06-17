/**
 * Persist owner Telegram session to agent_kv_settings (survives PM2 restart).
 */
import { ownerState } from './owner-state.mjs'

const KV_KEY = 'owner_telegram_state'

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
