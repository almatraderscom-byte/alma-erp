/**
 * CSE5 cloned-owner-voice lifecycle helpers.
 *
 * Provider IDs stay worker-side. Every use is re-checked against the durable
 * active version, and lifecycle transitions append an audit row.
 */
import { randomUUID } from 'node:crypto'

export const OWNER_STUDIO_USAGE_CONTEXT = 'owner_studio'

// Existing CSE1–CSE4/TTS profiles remain independent of the cloned owner voice.
// Never point these autonomous/staff helpers at a lifecycle voice.
export const VOICE_IDS = {
  charlie: 'IKne3meq5aSn9XLyUdCD',
  river: 'SAz9YHcvj6GT2YYXdXww',
}

export function staffVoiceId() {
  return process.env.ELEVENLABS_VOICE_STAFF ?? VOICE_IDS.charlie
}

export function maleVoiceId() {
  return process.env.ELEVENLABS_VOICE_MALE ?? staffVoiceId()
}

export function femaleVoiceId() {
  return process.env.ELEVENLABS_VOICE_FEMALE ?? VOICE_IDS.river
}

export function resolveVoiceId(profile = 'staff') {
  if (profile === 'female') return femaleVoiceId()
  if (profile === 'male') return maleVoiceId()
  return staffVoiceId()
}

export function detectVoiceGenderFromText(text) {
  const raw = String(text ?? '')
  const female =
    /\b(female|river)\b/i.test(raw)
    || /(?:মেয়ে|নারী|মহিলা|মেয়েলি).{0,25}(?:voice|ভয়েস|কণ্ঠ|শুন)/iu.test(raw)
    || /(?:voice|ভয়েস|কণ্ঠ).{0,25}(?:মেয়ে|নারী|মহিলা)/iu.test(raw)
  if (female) return 'female'
  const male =
    /\b(male|charlie)\b/i.test(raw)
    || /(?:পুরুষ|ছেলে).{0,25}(?:voice|ভয়েস|কণ্ঠ)/iu.test(raw)
    || /(?:voice|ভয়েস).{0,25}(?:পুরুষ|ছেলে)/iu.test(raw)
  if (male) return 'male'
  return null
}

export function wantsElevenLabsFromText(text) {
  const raw = String(text ?? '')
  return /eleven\s*labs?|ইলেভেন\s*ল্যাব/i.test(raw) || detectVoiceGenderFromText(raw) !== null
}

export function parseOwnerVoiceIntent(text) {
  const raw = String(text ?? '').trim()
  const gender = detectVoiceGenderFromText(raw)
  const useElevenLabs = wantsElevenLabsFromText(raw)
  const hasVoiceKeyword =
    /\b(voice|audio|read aloud|voice note|shuniye|shunao)\b/i.test(raw)
    || /শুনান|শুনতে|শোনাও|শুনিয়ে|কণ্ঠে|কথায় বল|ভয়েস/i.test(raw)
  const outboundVoice =
    /(?:স্টাফ|staff|তাকে|take|কাউকে|কারো|জনকে|কর্মচারী|কর্মী|মুস্তাহিদ|mustahid|ইয়াফি|eyafi|employee).{0,50}(?:voice|ভয়েস|শুনান|শুনিয়ে|audio)/iu.test(raw)
    || /(?:voice|ভয়েস|শুনান|শুনিয়ে|audio).{0,50}(?:স্টাফ|staff|তাকে|take|কাউকে|কারো|জনকে|পাঠাও|জানাও|দাও|দিতে|message|মেসেজ|বার্তা)/iu.test(raw)
    || /(?:message|মেসেজ|বার্তা|নোটিস).{0,40}(?:voice|ভয়েস|শুনান)/iu.test(raw)
    || /(?:voice|ভয়েস).{0,30}(?:ও\s*)?(?:take|তাকে|জেনো|যেনো).{0,15}(?:দে|দাও|দিতে|পাঠ)/iu.test(raw)
    || /(?:voice|ভয়েস|শুনিয়ে).{0,20}(?:ও\s*)(?:take|তাকে)/iu.test(raw)
  const wantsVoice =
    hasVoiceKeyword
    && !outboundVoice
    && (
      /\b(voice|audio|read aloud|voice note|shuniye|shunao)\b/i.test(raw)
      || /শুনিয়ে দাও|বলে শোনাও|কথায় উত্তর|শুনান|শুনতে|শোনাও|কণ্ঠে|কথায় বল/i.test(raw)
      || /(?:আমাকে|amake|amk|amke|আমার|amr|amar|my).{0,25}(?:voice|ভয়েস|শুনান|শোনাও|কণ্ঠ)/iu.test(raw)
      || /(?:voice|ভয়েস).{0,25}(?:এ|e)?\s*(?:বল|bolo|উত্তর|reply|জবাব)/iu.test(raw)
      || useElevenLabs
    )
  const voiceProfile = gender === 'female' ? 'female' : 'male'
  return { wantsVoice, voiceProfile, useElevenLabs }
}

export function assertOwnerVoiceJobPayload(payload) {
  if (!payload || payload.ownerVoice !== true) throw new Error('owner_voice_flag_required')
  if (!payload.ownerId || typeof payload.ownerId !== 'string') throw new Error('owner_voice_owner_required')
  if (payload.usageContext !== OWNER_STUDIO_USAGE_CONTEXT) throw new Error('owner_voice_context_forbidden')
  if (payload.autonomous === true) throw new Error('owner_voice_autonomous_forbidden')
  if (payload.customerFacing === true) throw new Error('owner_voice_customer_facing_forbidden')
  if (!payload.voiceVersionId || typeof payload.voiceVersionId !== 'string') {
    throw new Error('owner_voice_version_required')
  }
  return true
}

async function one(supabase, table, id) {
  const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle()
  if (error || !data) throw new Error(`${table}_not_found`)
  return data
}

export async function loadOwnerVoiceVersion(supabase, payload, { requireActive = true } = {}) {
  assertOwnerVoiceJobPayload(payload)
  const version = await one(supabase, 'creative_voice_versions', payload.voiceVersionId)
  const voice = await one(supabase, 'creative_voices', version.voice_id)
  if (voice.owner_id !== payload.ownerId || voice.owner_only !== true) throw new Error('owner_voice_owner_mismatch')
  if (requireActive) {
    if (version.status !== 'active' || voice.active_version_id !== version.id) throw new Error('owner_voice_not_active')
    if (!version.provider_voice_id) throw new Error('owner_voice_provider_id_missing')
  }
  return { voice, version }
}

export async function appendVoiceAudit(supabase, {
  voiceId,
  voiceVersionId,
  ownerId,
  action,
  reason = null,
  metadata = {},
}) {
  const { error } = await supabase.from('creative_voice_audits').insert({
    id: randomUUID(),
    voice_id: voiceId,
    voice_version_id: voiceVersionId,
    owner_id: ownerId,
    action,
    provider: 'elevenlabs',
    reason,
    metadata,
  })
  if (error) throw new Error(`voice_audit_failed: ${error.message}`)
}

export async function activateClonedVoice(supabase, payload, providerVoiceId) {
  const { voice, version } = await loadOwnerVoiceVersion(supabase, payload, { requireActive: false })
  if (version.provider_voice_id && version.provider_voice_id !== providerVoiceId) {
    throw new Error('immutable_provider_voice_id_conflict')
  }
  if (['revoked', 'deletion_pending', 'deleted'].includes(version.status)) {
    throw new Error('voice_version_not_activatable')
  }

  if (voice.active_version_id && voice.active_version_id !== version.id) {
    const { error: oldError } = await supabase
      .from('creative_voice_versions')
      .update({ status: 'ready' })
      .eq('id', voice.active_version_id)
      .eq('status', 'active')
    if (oldError) throw new Error(`previous_voice_deactivate_failed: ${oldError.message}`)
  }
  const now = new Date().toISOString()
  const { error: versionError } = await supabase
    .from('creative_voice_versions')
    .update({
      provider_voice_id: providerVoiceId,
      status: 'active',
      activated_at: now,
      revoked_at: null,
    })
    .eq('id', version.id)
  if (versionError) throw new Error(`voice_activate_failed: ${versionError.message}`)
  const { error: voiceError } = await supabase
    .from('creative_voices')
    .update({ active_version_id: version.id, updated_at: now })
    .eq('id', voice.id)
  if (voiceError) throw new Error(`active_voice_pointer_failed: ${voiceError.message}`)
  await appendVoiceAudit(supabase, {
    voiceId: voice.id,
    voiceVersionId: version.id,
    ownerId: payload.ownerId,
    action: 'provider_created_and_activated',
    metadata: { providerVoiceIdRecorded: true, version: version.version },
  })
  return { voice, version: { ...version, provider_voice_id: providerVoiceId, status: 'active' } }
}

export async function markProviderVoiceDeleted(supabase, payload) {
  const { voice, version } = await loadOwnerVoiceVersion(supabase, payload, { requireActive: false })
  const now = new Date().toISOString()
  if (voice.active_version_id === version.id) {
    const { error: voiceError } = await supabase
      .from('creative_voices')
      .update({ active_version_id: null, updated_at: now })
      .eq('id', voice.id)
    if (voiceError) throw new Error(`active_voice_clear_failed: ${voiceError.message}`)
  }
  const { error: versionError } = await supabase
    .from('creative_voice_versions')
    .update({
      status: 'deleted',
      revoked_at: version.revoked_at ?? now,
      provider_deleted_at: now,
    })
    .eq('id', version.id)
  if (versionError) throw new Error(`voice_delete_record_failed: ${versionError.message}`)
  await appendVoiceAudit(supabase, {
    voiceId: voice.id,
    voiceVersionId: version.id,
    ownerId: payload.ownerId,
    action: 'provider_deleted',
    metadata: { providerConfirmed: true },
  })
  return { voice, version }
}

export async function deleteElevenLabsVoice(providerVoiceId, {
  apiKey = process.env.ELEVENLABS_API_KEY ?? '',
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set on the worker')
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(providerVoiceId)}`, {
    method: 'DELETE',
    headers: { 'xi-api-key': apiKey },
    signal: AbortSignal.timeout(60_000),
  })
  if (res.status === 404) return { status: 'already_absent' }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`elevenlabs voice delete ${res.status}: ${body.slice(0, 160)}`)
  }
  return res.json().catch(() => ({ status: 'ok' }))
}
