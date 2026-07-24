import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activateClonedVoice,
  assertOwnerVoiceJobPayload,
  deleteElevenLabsVoice,
  loadOwnerVoiceVersion,
  markProviderVoiceDeleted,
  parseOwnerVoiceIntent,
  resolveVoiceId,
} from '../elevenlabs-voices.mjs'
import { buildPartialEditFfmpegArgs } from '../video-edit.mjs'

const payload = {
  ownerVoice: true,
  ownerId: 'owner-1',
  usageContext: 'owner_studio',
  voiceVersionId: 'version-2',
}

function lifecycleHarness() {
  const tables = {
    creative_voices: new Map([['voice-1', {
      id: 'voice-1',
      owner_id: 'owner-1',
      owner_only: true,
      active_version_id: 'version-1',
    }]]),
    creative_voice_versions: new Map([
      ['version-1', { id: 'version-1', voice_id: 'voice-1', version: 1, status: 'active', provider_voice_id: 'provider-1' }],
      ['version-2', { id: 'version-2', voice_id: 'voice-1', version: 2, status: 'pending', provider_voice_id: null }],
    ]),
    creative_voice_audits: [],
  }
  return {
    tables,
    client: {
      from(name) {
        return {
          select() {
            return {
              eq(_column, id) {
                return { async maybeSingle() { return { data: tables[name].get(id) ?? null, error: null } } }
              },
            }
          },
          update(patch) {
            const filters = []
            const chain = {
              eq(column, value) {
                filters.push([column, value])
                if (filters.length === 1 && column === 'id') {
                  const row = tables[name].get(value)
                  if (row && filters.every(([key, expected]) => row[key] === expected)) Object.assign(row, patch)
                }
                return chain
              },
              then(resolve) { resolve({ error: null }) },
            }
            return chain
          },
          async insert(row) {
            tables[name].push(row)
            return { error: null }
          },
        }
      },
    },
  }
}

test('owner voice jobs reject autonomous/customer/direct contexts', () => {
  assert.equal(assertOwnerVoiceJobPayload(payload), true)
  assert.throws(() => assertOwnerVoiceJobPayload({ ...payload, usageContext: 'assistant' }), /context_forbidden/)
  assert.throws(() => assertOwnerVoiceJobPayload({ ...payload, autonomous: true }), /autonomous_forbidden/)
  assert.throws(() => assertOwnerVoiceJobPayload({ ...payload, customerFacing: true }), /customer_facing_forbidden/)
})

test('existing staff and owner-requested profile routing is preserved', () => {
  assert.equal(resolveVoiceId('staff'), 'IKne3meq5aSn9XLyUdCD')
  assert.equal(resolveVoiceId('female'), 'SAz9YHcvj6GT2YYXdXww')
  assert.equal(parseOwnerVoiceIntent('আমাকে female voice এ বলো').voiceProfile, 'female')
})

test('clone activation keeps versions immutable and appends audit', async () => {
  const harness = lifecycleHarness()
  await activateClonedVoice(harness.client, payload, 'provider-2')
  assert.equal(harness.tables.creative_voices.get('voice-1').active_version_id, 'version-2')
  assert.equal(harness.tables.creative_voice_versions.get('version-1').status, 'ready')
  assert.equal(harness.tables.creative_voice_versions.get('version-2').provider_voice_id, 'provider-2')
  assert.equal(harness.tables.creative_voice_versions.get('version-2').status, 'active')
  assert.equal(harness.tables.creative_voice_audits.at(-1).action, 'provider_created_and_activated')
  await assert.rejects(() => activateClonedVoice(harness.client, payload, 'different-provider'), /immutable_provider_voice_id_conflict/)
})

test('provider deletion is durable and idempotent for an already absent provider voice', async () => {
  const harness = lifecycleHarness()
  await activateClonedVoice(harness.client, payload, 'provider-2')
  await markProviderVoiceDeleted(harness.client, payload)
  assert.equal(harness.tables.creative_voices.get('voice-1').active_version_id, null)
  assert.equal(harness.tables.creative_voice_versions.get('version-2').status, 'deleted')
  assert.ok(harness.tables.creative_voice_versions.get('version-2').provider_deleted_at)
  assert.equal(harness.tables.creative_voice_audits.at(-1).action, 'provider_deleted')

  const response = await deleteElevenLabsVoice('provider-2', {
    apiKey: 'test',
    fetchImpl: async () => ({ status: 404, ok: false }),
  })
  assert.deepEqual(response, { status: 'already_absent' })
})

test('inactive versions cannot be used for synthesis', async () => {
  const harness = lifecycleHarness()
  await assert.rejects(() => loadOwnerVoiceVersion(harness.client, payload), /owner_voice_not_active/)
})

test('partial video edit reorders trims and rerenders only the requested local tracks', () => {
  const args = buildPartialEditFfmpegArgs({
    inputFile: '/tmp/source.mp4',
    outFile: '/tmp/edited.mp4',
    hasAudio: true,
    subtitleFile: '/tmp/captions.srt',
    musicFile: '/tmp/music.mp3',
    voiceoverFile: '/tmp/voiceover.mp3',
    contract: {
      preserveVisualSource: true,
      segments: [
        { id: 'second', startSec: 8, endSec: 10, order: 0 },
        { id: 'first', startSec: 1, endSec: 4, order: 1 },
      ],
      crop: { aspect: '9:16', focusX: 0.4, focusY: 0.6, safeZone: true },
      volumes: { original: 0.8, music: 0.25, voiceover: 1 },
      captionPlacement: 'top',
      transcript: [],
      cover: { atSec: 1 },
      rerender: ['visual', 'captions', 'audio'],
    },
  })
  const command = args.join(' ')
  assert.ok(command.indexOf('trim=start=8:end=10') < command.indexOf('trim=start=1:end=4'))
  assert.match(command, /concat=n=2:v=1:a=1/)
  assert.match(command, /scale=1080:1920/)
  assert.match(command, /Alignment=8/)
  assert.match(command, /volume=0\.8/)
  assert.match(command, /volume=0\.25/)
  assert.match(command, /volume=1/)
  assert.match(command, /amix=inputs=3/)
  assert.match(command, /\/tmp\/edited\.mp4$/)
})
