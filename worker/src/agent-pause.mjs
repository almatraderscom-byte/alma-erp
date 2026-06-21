/**
 * Worker-side master-pause gate.
 *
 * Mirrors src/agent/lib/agent-controls.ts: the owner's "Control Center" stores a
 * JSON blob under agent_kv_settings(key='agent_controls'); its `paused` flag is
 * the master switch that is meant to stop the agent EVERYWHERE — web AND the VPS
 * worker (Telegram replies + proactive schedulers). The web route already honors
 * it (isAgentPaused() in chat/route.ts); this is the worker half so toggling the
 * monitor switch actually silences Telegram too.
 *
 * FAIL-OPEN: any storage error → treated as NOT paused. A settings glitch must
 * never silently brick the live agent (same contract as the TS side).
 *
 * Cached briefly so per-minute schedulers and every inbound Telegram update don't
 * hammer the DB. A toggle takes effect within TTL_MS.
 */
import { createClient } from '@supabase/supabase-js'

const KV_KEY = 'agent_controls'
const TTL_MS = 10_000

let _cache = { at: 0, paused: false }
let _sb = null

function client(supabase) {
  if (supabase) return supabase
  if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  return _sb
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} [supabase] reuse an existing client when available
 * @returns {Promise<boolean>} true only when the owner has explicitly paused the agent
 */
export async function isAgentPaused(supabase) {
  const now = Date.now()
  if (now - _cache.at < TTL_MS) return _cache.paused
  try {
    const { data, error } = await client(supabase)
      .from('agent_kv_settings')
      .select('value')
      .eq('key', KV_KEY)
      .maybeSingle()
    if (error) throw error
    let paused = false
    if (data?.value) {
      try {
        paused = JSON.parse(data.value)?.paused === true
      } catch {
        paused = false
      }
    }
    _cache = { at: now, paused }
    return paused
  } catch (err) {
    console.warn('[agent-pause] read failed — failing open (not paused):', err.message)
    _cache = { at: now, paused: false }
    return false
  }
}

/** Drop the cache so the next read hits the DB immediately. */
export function invalidateAgentPauseCache() {
  _cache = { at: 0, paused: false }
}
