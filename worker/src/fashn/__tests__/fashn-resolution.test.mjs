import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { processFashnImageGen } from '../process.mjs'

process.env.FASHN_API_KEY = 'test-key'
process.env.APP_URL = 'https://app.test'
process.env.AGENT_INTERNAL_TOKEN = 'test-token'

function fakeSupabase() {
  const kv = new Map([['agent_qc_level', 'off']])
  const uploaded = new Map()
  return {
    kv,
    uploaded,
    storage: {
      from(bucket) {
        assert.equal(bucket, 'agent-files')
        return {
          upload: async (path, bytes, options) => {
            uploaded.set(path, { bytes: Buffer.from(bytes), options })
            return { error: null }
          },
          download: async (path) => {
            const stored = uploaded.get(path)
            if (!stored) return { data: null, error: new Error(`missing ${path}`) }
            return {
              data: new Blob([stored.bytes], { type: stored.options.contentType }),
              error: null,
            }
          },
        }
      },
    },
    from(table) {
      assert.equal(table, 'agent_kv_settings')
      return {
        select() {
          return {
            eq(_column, key) {
              return {
                maybeSingle: async () => ({
                  data: kv.has(key) ? { value: kv.get(key) } : null,
                }),
              }
            },
          }
        },
        upsert: async (row) => {
          kv.set(row.key, row.value)
          return { error: null }
        },
        delete() {
          return {
            eq: async (_column, key) => {
              kv.delete(key)
              return { error: null }
            },
          }
        },
      }
    },
  }
}

async function runFashnFixture({
  pendingActionId,
  requestedTier,
  width,
  height,
  model = 'tryon-max',
  aspectRatio,
}) {
  const output = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 77, g: 88, b: 99 },
    },
  }).png().toBuffer()
  const dataUri = `data:image/png;base64,${output.toString('base64')}`
  const supabase = fakeSupabase()
  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    fetchCalls.push({ href, init })
    if (href === 'https://api.fashn.ai/v1/run') {
      const body = JSON.parse(init.body)
      assert.equal(body.inputs.resolution, requestedTier)
      if (aspectRatio) assert.equal(body.inputs.aspect_ratio, aspectRatio)
      else assert.ok(!('aspect_ratio' in body.inputs))
      return { ok: true, status: 200, json: async () => ({ id: `pred-${pendingActionId}` }) }
    }
    if (href.endsWith(`/status/pred-${pendingActionId}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'completed', output: [dataUri] }),
      }
    }
    throw new Error(`unscripted fetch ${href}`)
  }

  try {
    const costs = []
    const result = await processFashnImageGen({
      supabase,
      pendingActionId,
      payload: {
        fashnModel: model,
        fashnInputs: { model_image: 'data:image/png;base64,AA==' },
        fashnOptions: {
          resolution: requestedTier,
          aspectRatio,
          generationMode: 'quality',
          outputFormat: 'png',
        },
      },
      logCost: (entry) => costs.push(entry),
    })
    return { result, output, supabase, costs, fetchCalls }
  } finally {
    globalThis.fetch = realFetch
  }
}

test('direct FASHN sends the selected 2K tier and preserves verified output bytes', async () => {
  const { result, output, supabase, costs, fetchCalls } = await runFashnFixture({
    pendingActionId: 'fashn-2k',
    requestedTier: '2k',
    width: 2048,
    height: 2048,
  })

  assert.equal(fetchCalls.filter((call) => call.href.endsWith('/run')).length, 1)
  assert.equal(result.original.requestedTier, '2k')
  assert.equal(result.original.actualTier, '2k')
  assert.equal(result.original.validation, 'verified')
  assert.equal(result.original.width, 2048)
  assert.equal(result.original.height, 2048)
  assert.deepEqual(supabase.uploaded.get(result.storagePath).bytes, output)
  assert.equal(costs[0].units.resolution, '2k')
})

test('direct FASHN keeps undersized provider bytes but marks them failed', async () => {
  const { result, output, supabase } = await runFashnFixture({
    pendingActionId: 'fashn-mismatch',
    requestedTier: '2k',
    width: 1024,
    height: 1024,
  })

  assert.equal(result.original.validation, 'failed')
  assert.match(result.original.validationErrors[0], /2K requires long edge >= 2048/)
  assert.deepEqual(supabase.uploaded.get(result.storagePath).bytes, output)
})

test('direct FASHN product-to-model passes its audited explicit aspect ratio', async () => {
  const { result, costs } = await runFashnFixture({
    pendingActionId: 'fashn-product',
    requestedTier: '1k',
    width: 928,
    height: 1152,
    model: 'product-to-model',
    aspectRatio: '4:5',
  })

  assert.equal(result.original.requestedAspectRatio, '4:5')
  assert.equal(result.original.validation, 'verified')
  assert.equal(costs[0].units.aspectRatio, '4:5')
})
