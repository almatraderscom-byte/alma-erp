/**
 * CS6 — VTON adapter contract tests (node:test, zero new dependencies).
 * Run: node --test worker/src/fal/__tests__/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCatVtonInput, processCatVton, CAT_VTON_ENDPOINT } from '../adapters/cat-vton.mjs'
import { buildFashnV16Input, resolveFashnCategory, FASHN_V16_ENDPOINT } from '../adapters/fashn-v16.mjs'

process.env.FAL_KEY = 'test-key'
process.env.APP_URL = 'https://app.test'
process.env.AGENT_INTERNAL_TOKEN = 'tok'

// ── pure input builders ──────────────────────────────────────────────────────

test('cat-vton input: owner-locked field names + CS6 defaults (30 steps, guidance 2.5)', () => {
  const input = buildCatVtonInput({
    humanDataUri: 'data:h',
    garmentDataUri: 'data:g',
    clothType: 'overall',
  })
  assert.equal(input.human_image_url, 'data:h')
  assert.equal(input.garment_image_url, 'data:g')
  assert.equal(input.cloth_type, 'overall')
  assert.equal(input.num_inference_steps, 30)
  assert.equal(input.guidance_scale, 2.5)
  assert.ok(!('seed' in input), 'no seed key unless supplied')
})

test('cat-vton input: fixed seed passes through; invalid cloth_type rejected', () => {
  const input = buildCatVtonInput({
    humanDataUri: 'h', garmentDataUri: 'g', clothType: 'outer', seed: 4242,
  })
  assert.equal(input.seed, 4242)
  assert.equal(input.cloth_type, 'outer')
  assert.throws(() => buildCatVtonInput({ humanDataUri: 'h', garmentDataUri: 'g', clothType: 'dress' }), /invalid cloth_type/)
})

test('fashn v1.6 category mapping: cloth override wins, then classifier, then auto', () => {
  assert.equal(resolveFashnCategory({ clothType: 'overall' }), 'one-pieces')
  assert.equal(resolveFashnCategory({ clothType: 'upper' }), 'tops')
  assert.equal(resolveFashnCategory({ clothType: 'outer' }), 'tops')
  assert.equal(resolveFashnCategory({ clothType: 'lower' }), 'bottoms')
  assert.equal(resolveFashnCategory({ clothType: null, fashnCategory: 'one-pieces' }), 'one-pieces')
  assert.equal(resolveFashnCategory({ clothType: undefined, fashnCategory: 'nonsense' }), 'auto')
})

test('fashn v1.6 input: png single sample, balanced default mode, seed optional', () => {
  const input = buildFashnV16Input({ modelDataUri: 'm', garmentDataUri: 'g', category: 'one-pieces', mode: 'weird' })
  assert.equal(input.model_image, 'm')
  assert.equal(input.garment_image, 'g')
  assert.equal(input.category, 'one-pieces')
  assert.equal(input.mode, 'balanced')
  assert.equal(input.output_format, 'png')
  assert.equal(input.num_samples, 1)
  const seeded = buildFashnV16Input({ modelDataUri: 'm', garmentDataUri: 'g', category: 'tops', mode: 'quality', seed: 7 })
  assert.equal(seeded.seed, 7)
  assert.equal(seeded.mode, 'quality')
})

test('endpoints match the roadmap exactly', () => {
  assert.equal(CAT_VTON_ENDPOINT, 'fal-ai/cat-vton')
  assert.equal(FASHN_V16_ENDPOINT, 'fal-ai/fashn/tryon/v1.6')
})

// ── full adapter flow (stubbed network + storage) ───────────────────────────

function fakeSupabase() {
  const kv = new Map()
  const uploaded = new Map()
  return {
    kv,
    uploaded,
    storage: {
      from(bucket) {
        assert.equal(bucket, 'agent-files')
        return {
          download: async () => ({ data: new Blob([Buffer.from('img-bytes')], { type: 'image/jpeg' }), error: null }),
          upload: async (path, buf) => { uploaded.set(path, buf); return { error: null } },
        }
      },
    },
    from(table) {
      assert.equal(table, 'agent_kv_settings')
      return {
        select() {
          return { eq: (_c, key) => ({ maybeSingle: async () => ({ data: kv.has(key) ? { value: kv.get(key) } : null }) }) }
        },
        upsert: async (row) => { kv.set(row.key, row.value); return { error: null } },
        delete() {
          return { eq: async (_c, key) => { kv.delete(key); return { error: null } } }
        },
      }
    },
  }
}

test('processCatVton end to end: submit → poll → download → truthful metadata; QC off', async (t) => {
  const supabase = fakeSupabase()
  supabase.kv.set('agent_qc_level', 'off')
  supabase.kv.set('cs_idm_vton_cost_usd', '0.04')

  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetchCalls.push({ url: u, method: init.method ?? 'GET' })
    if (u === 'https://queue.fal.run/fal-ai/cat-vton' && init.method === 'POST') {
      const body = JSON.parse(init.body)
      assert.equal(body.cloth_type, 'overall')
      assert.equal(body.num_inference_steps, 30)
      assert.equal(body.guidance_scale, 2.5)
      assert.equal(body.seed, 99)
      assert.ok(body.human_image_url.startsWith('data:'))
      return { ok: true, status: 200, json: async () => ({ request_id: 'rq-cat-1' }) }
    }
    if (u.includes('/requests/rq-cat-1/status')) {
      return { ok: true, status: 200, json: async () => ({ status: 'COMPLETED' }) }
    }
    if (u.includes('/requests/rq-cat-1')) {
      return { ok: true, status: 200, json: async () => ({ image: { url: 'https://cdn.fal/img.png' }, seed: 99 }) }
    }
    if (u === 'https://cdn.fal/img.png') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => Buffer.from('png-bytes').buffer,
      }
    }
    throw new Error(`unscripted fetch: ${u}`)
  }
  t.after(() => { globalThis.fetch = realFetch })

  const costs = []
  const result = await processCatVton({
    supabase,
    pendingActionId: 'pa-cat-1',
    payload: {
      productImagePath: 'uploads/product.jpg',
      modelImagePath: 'uploads/model.jpg',
      clothType: 'overall',
      numInferenceSteps: 30,
      guidanceScale: 2.5,
      seed: 99,
    },
    logCost: (p) => costs.push(p),
  })

  assert.equal(result.provider, 'fal')
  assert.equal(result.falEngine, 'fal_idm_vton')
  assert.equal(result.falEndpointId, 'fal-ai/cat-vton')
  assert.equal(result.requestId, 'rq-cat-1')
  assert.equal(result.seed, 99)
  assert.equal(result.researchOnly, true)
  assert.ok(result.storagePath.startsWith('generated/studio-pa-cat-1'))
  assert.ok(supabase.uploaded.has(result.storagePath), 'artifact landed in agent-files')
  assert.equal(await supabase.kv.has('fal_request:pa-cat-1'), false, 'durable state cleared after upload')
  assert.equal(costs.length, 1)
  assert.equal(costs[0].costUsd, 0.04, 'kv-configured research cost used')
  assert.equal(fetchCalls.filter((c) => c.method === 'POST' && c.url.endsWith('cat-vton')).length, 1, 'exactly one paid submit')
})

test('processCatVton: fal output download failure keeps durable state (resume, no re-pay)', async (t) => {
  const supabase = fakeSupabase()
  supabase.kv.set('agent_qc_level', 'off')

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.endsWith('/fal-ai/cat-vton') && init.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ request_id: 'rq-cat-2' }) }
    }
    if (u.includes('/requests/rq-cat-2/status')) return { ok: true, status: 200, json: async () => ({ status: 'COMPLETED' }) }
    if (u.includes('/requests/rq-cat-2')) return { ok: true, status: 200, json: async () => ({ image: { url: 'https://cdn.fal/broken.png' } }) }
    if (u === 'https://cdn.fal/broken.png') return { ok: false, status: 502, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
    throw new Error(`unscripted fetch: ${u}`)
  }
  t.after(() => { globalThis.fetch = realFetch })

  await assert.rejects(
    () => processCatVton({
      supabase,
      pendingActionId: 'pa-cat-2',
      payload: { productImagePath: 'p.jpg', modelImagePath: 'm.jpg', clothType: 'overall' },
      logCost: () => {},
    }),
    /fal output download HTTP 502/,
  )
  assert.ok(supabase.kv.has('fal_request:pa-cat-2'), 'state kept — retry resumes the SAME paid request')
})
