import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { effectiveQcLevel, productionCoreAxesPass, scoreImageViaApi } from '../image-qc.mjs'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.WORKER_PREVIEW_E2E_BYPASS_SECRET
})

test('signed production policy cannot be disabled by mutable global QC level', () => {
  assert.equal(effectiveQcLevel('off', 'production'), 'strict')
  assert.equal(effectiveQcLevel('normal', 'production'), 'strict')
  assert.equal(effectiveQcLevel('off', 'preview'), 'off')
})

test('production core axes all require four', () => {
  assert.equal(productionCoreAxesPass({ garment_fidelity: 4, model_preserved: 4, anatomy: 4 }), true)
  assert.equal(productionCoreAxesPass({ garment_fidelity: 5, model_preserved: 5, anatomy: 3 }), false)
})

test('preview QC scoring forwards the exact Vercel protection bypass', async () => {
  process.env.WORKER_PREVIEW_E2E_BYPASS_SECRET = 'preview-bypass-secret'
  let request
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init }
    return Response.json({ pass: true, score: { overall: 5 } })
  }

  await scoreImageViaApi({
    appUrl: 'https://preview.example',
    token: 'internal-token',
    storagePath: 'generated/result.png',
  })

  assert.equal(request.url, 'https://preview.example/api/assistant/internal/image-qc-score')
  assert.equal(request.init.headers.Authorization, 'Bearer internal-token')
  assert.equal(request.init.headers['x-vercel-protection-bypass'], 'preview-bypass-secret')
})

test('isolated preview certification fails closed when QC is unavailable', async () => {
  process.env.WORKER_PREVIEW_E2E_BYPASS_SECRET = 'preview-bypass-secret'
  globalThis.fetch = async () => {
    throw new Error('qc transport down')
  }
  const supabase = {
    from() {
      return {
        select() { return this },
        eq() { return this },
        async maybeSingle() { return { data: { value: 'production' } } },
      }
    },
  }

  await assert.rejects(
    () => import('../image-qc.mjs').then(({ runImageQcLoop }) => runImageQcLoop({
      supabase,
      appUrl: 'https://preview.example',
      token: 'internal-token',
      qcLevel: 'strict',
      initialPath: 'generated/result.png',
      pipelineMode: 'production',
      regenerate: async () => 'generated/retry.png',
    })),
    /preview_qc_unavailable:qc transport down/,
  )
})
