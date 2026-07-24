import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import {
  buildBanglaCaption,
  processCampaignPackStage,
} from '../campaign-pack.mjs'

function storageHarness(sourceBuffer) {
  const uploads = new Map()
  return {
    uploads,
    client: {
      storage: {
        from() {
          return {
            async download() {
              return { data: new Blob([sourceBuffer], { type: 'image/jpeg' }), error: null }
            },
            async upload(path, buffer) {
              uploads.set(path, buffer)
              return { error: null }
            },
          }
        },
      },
    },
  }
}

test('campaign pack local layout is deterministic, correctly sized, and free', async () => {
  const source = await sharp({
    create: {
      width: 500,
      height: 700,
      channels: 3,
      background: '#E07A5F',
    },
  }).jpeg().toBuffer()
  const storage = storageHarness(source)
  const payload = {
    provider: 'campaign_pack_local',
    operation: 'layout',
    sourceRef: 'products/alma-101.jpg',
    width: 1080,
    height: 1080,
    variant: 'post-1x1',
    campaignPack: {
      packId: 'pack-1',
      stageId: 'post-1x1',
      attempt: 1,
    },
  }

  const first = await processCampaignPackStage({
    supabase: storage.client,
    pendingActionId: 'job-1',
    payload,
  })
  const second = await processCampaignPackStage({
    supabase: storage.client,
    pendingActionId: 'job-1',
    payload,
  })

  assert.equal(first.storagePath, 'campaign-packs/pack-1/post-1x1-attempt-1.jpg')
  assert.equal(first.storagePath, second.storagePath)
  assert.equal(first.costUsd, 0)
  const metadata = await sharp(storage.uploads.get(first.storagePath)).metadata()
  assert.equal(metadata.width, 1080)
  assert.equal(metadata.height, 1080)
})

test('campaign pack caption is Bangla, product-specific, and makes no upload', async () => {
  const storage = storageHarness(Buffer.from('unused'))
  const result = await processCampaignPackStage({
    supabase: storage.client,
    pendingActionId: 'job-caption',
    payload: {
      operation: 'caption',
      product: { code: 'ALMA-101', name: 'প্রিমিয়াম পাঞ্জাবি', priceBdt: 3490 },
      recipe: { captionTone: 'premium' },
      campaignPack: { packId: 'pack-1', stageId: 'caption-bn', attempt: 1 },
    },
  })

  assert.match(result.captionBn, /প্রিমিয়াম পাঞ্জাবি/)
  assert.match(result.captionBn, /ALMA-101/)
  assert.equal(storage.uploads.size, 0)
  assert.equal(result.costUsd, 0)
  assert.equal(buildBanglaCaption({ name: 'A', code: 'B', priceBdt: 1 }, {}), buildBanglaCaption({ name: 'A', code: 'B', priceBdt: 1 }, {}))
})
