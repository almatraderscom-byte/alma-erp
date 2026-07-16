/**
 * CS7 — FLUX Fill adapter contract tests (node:test, zero new dependencies).
 * Includes the MASK POLARITY FIXTURE: a real sharp composite proving
 * white=edit / black=keep, and that protected pixels survive byte-identical.
 * Run: node --test worker/src/fal/__tests__/flux-fill-adapter.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  FLUX_FILL_ENDPOINT,
  buildFluxFillInput,
  processFluxFill,
  protectedComposite,
} from '../adapters/flux-fill.mjs'

process.env.FAL_KEY = 'test-key'

function solidPng(width, height, { r, g, b }) {
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer()
}

/** Mask: left half BLACK (keep), right half WHITE (edit). */
async function halfMaskPng(width, height) {
  const raw = Buffer.alloc(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw[y * width + x] = x >= width / 2 ? 255 : 0
    }
  }
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer()
}

test('input builder: CS7 precision defaults locked', () => {
  const input = buildFluxFillInput({ imageDataUri: 'data:i', maskDataUri: 'data:m', prompt: 'fix it' })
  assert.equal(input.enhance_prompt, false)
  assert.equal(input.num_images, 1)
  assert.equal(input.output_format, 'png')
  assert.equal(input.safety_tolerance, '2')
  assert.ok(!('seed' in input))
  assert.equal(buildFluxFillInput({ imageDataUri: 'i', maskDataUri: 'm', prompt: 'x', seed: 5 }).seed, 5)
  assert.throws(() => buildFluxFillInput({ imageDataUri: 'i', maskDataUri: 'm', prompt: '  ' }), /prompt required/)
  assert.equal(FLUX_FILL_ENDPOINT, 'fal-ai/flux-pro/v1/fill')
})

test('POLARITY FIXTURE: white=edit gets fill pixels, black=keep stays byte-identical', async () => {
  const W = 64
  const H = 32
  const baseBuf = await solidPng(W, H, { r: 200, g: 50, b: 50 }) // red base
  const fillBuf = await solidPng(W, H, { r: 10, g: 200, b: 30 }) // green fill
  const maskBuf = await halfMaskPng(W, H) // left keep, right edit

  const { composited, maxKeepDelta, keepChangedPct } = await protectedComposite({ baseBuf, maskBuf, fillBuf })
  assert.equal(maxKeepDelta, 0, 'protected (black) pixels byte-identical')
  assert.equal(keepChangedPct, 0)

  const raw = await sharp(composited).ensureAlpha().raw().toBuffer()
  const px = (x, y) => {
    const i = (y * W + x) * 4
    return [raw[i], raw[i + 1], raw[i + 2]]
  }
  // left (KEEP) = red base; right (EDIT) = green fill
  assert.deepEqual(px(4, 16), [200, 50, 50])
  assert.deepEqual(px(W - 4, 16), [10, 200, 30])
})

test('feathered boundary blends only inside the band', async () => {
  const W = 64
  const H = 32
  const baseBuf = await solidPng(W, H, { r: 255, g: 0, b: 0 })
  const fillBuf = await solidPng(W, H, { r: 0, g: 0, b: 255 })
  // feather the half mask with a blur — boundary grays appear
  const feathered = await sharp(await halfMaskPng(W, H)).blur(3).png().toBuffer()
  const { composited, maxKeepDelta } = await protectedComposite({ baseBuf, maskBuf: feathered, fillBuf })
  assert.equal(maxKeepDelta, 0, 'fully-black zone still untouched')
  const raw = await sharp(composited).ensureAlpha().raw().toBuffer()
  const mid = (16 * W + Math.floor(W / 2)) * 4
  // boundary pixel is a blend (neither pure red nor pure blue)
  assert.ok(raw[mid] > 20 && raw[mid] < 235, `boundary blended, got r=${raw[mid]}`)
})

function fakeSupabase(files) {
  const kv = new Map()
  const uploaded = new Map()
  return {
    kv,
    uploaded,
    storage: {
      from() {
        return {
          download: async (path) => {
            if (!files[path]) return { data: null, error: { message: 'missing' } }
            return { data: new Blob([files[path]], { type: 'image/png' }), error: null }
          },
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

test('processFluxFill end to end: durable submit → composite → truthful metadata', async (t) => {
  const W = 100
  const H = 100
  const files = {
    'uploads/base.png': await solidPng(W, H, { r: 120, g: 120, b: 120 }),
    'masks/m1.png': await halfMaskPng(W, H),
  }
  const supabase = fakeSupabase(files)
  const fillOutput = await solidPng(W, H, { r: 0, g: 255, b: 0 })

  const realFetch = globalThis.fetch
  let submits = 0
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://queue.fal.run/fal-ai/flux-pro/v1/fill' && init.method === 'POST') {
      submits++
      const body = JSON.parse(init.body)
      assert.equal(body.enhance_prompt, false)
      assert.equal(body.num_images, 1)
      assert.ok(body.image_url.startsWith('data:image/png'))
      assert.ok(body.mask_url.startsWith('data:image/png'))
      return { ok: true, status: 200, json: async () => ({ request_id: 'rq-fill-1' }) }
    }
    if (u.includes('/requests/rq-fill-1/status')) return { ok: true, status: 200, json: async () => ({ status: 'COMPLETED' }) }
    if (u.includes('/requests/rq-fill-1')) return { ok: true, status: 200, json: async () => ({ images: [{ url: 'https://cdn.fal/fill.png' }], seed: 77 }) }
    if (u === 'https://cdn.fal/fill.png') {
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => fillOutput.buffer.slice(fillOutput.byteOffset, fillOutput.byteOffset + fillOutput.byteLength) }
    }
    throw new Error(`unscripted fetch: ${u}`)
  }
  t.after(() => { globalThis.fetch = realFetch })

  const costs = []
  const result = await processFluxFill({
    supabase,
    pendingActionId: 'pa-fill-1',
    payload: {
      baseImagePath: 'uploads/base.png',
      maskPath: 'masks/m1.png',
      fillPrompt: 'replace background with studio grey',
      maskPreset: 'replace_background',
    },
    logCost: (p) => costs.push(p),
  })

  assert.equal(submits, 1, 'exactly one paid submit')
  assert.equal(result.falEngine, 'fal_flux_fill')
  assert.equal(result.requestId, 'rq-fill-1')
  assert.equal(result.seed, 77)
  assert.equal(result.protectedDiff.maxKeepDelta, 0)
  assert.equal(result.costUsd, 0.05, '100x100 → 1MP floor × $0.05')
  assert.ok(supabase.uploaded.has(result.storagePath))
  assert.equal(supabase.kv.has('fal_request:pa-fill-1'), false, 'state cleared after artifact landed')

  // verify composited output: left = base grey, right = fill green
  const raw = await sharp(supabase.uploaded.get(result.storagePath)).ensureAlpha().raw().toBuffer()
  const px = (x, y) => { const i = (y * W + x) * 4; return [raw[i], raw[i + 1], raw[i + 2]] }
  assert.deepEqual(px(5, 50), [120, 120, 120])
  assert.deepEqual(px(95, 50), [0, 255, 0])
})
