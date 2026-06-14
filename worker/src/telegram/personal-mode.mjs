/**
 * Telegram owner personal/work mode toggle (persisted in agent_kv_settings).
 */

export function telegramPersonalModeKey(chatId) {
  return `tg_personal_mode_${chatId}`
}

export async function getTelegramPersonalMode(supabase, chatId) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', telegramPersonalModeKey(chatId))
    .maybeSingle()
  return data?.value === true || data?.value === 'true'
}

export async function setTelegramPersonalMode(supabase, chatId, enabled) {
  await supabase.from('agent_kv_settings').upsert({
    key: telegramPersonalModeKey(chatId),
    value: enabled,
    updated_at: new Date().toISOString(),
  })
}
