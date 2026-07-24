import sharp from 'sharp'

export const CAMPAIGN_PACK_LOCAL_PROVIDER = 'campaign_pack_local'

export const CAMPAIGN_PACK_DIMENSIONS = Object.freeze({
  'draft-a': { width: 1080, height: 1350 },
  'draft-b': { width: 1080, height: 1350 },
  'hero-4x5': { width: 1080, height: 1350 },
  'post-1x1': { width: 1080, height: 1080 },
  'story-9x16': { width: 1080, height: 1920 },
})

function campaignMeta(payload) {
  const value = payload?.campaignPack
  if (!value || typeof value !== 'object') throw new Error('campaign_pack_metadata_missing')
  if (!value.packId || !value.stageId || !value.attempt) throw new Error('campaign_pack_metadata_invalid')
  return value
}

function safeSegment(value, fallback) {
  const clean = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
  return clean || fallback
}

function isSafeRemoteUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

async function readSource(supabase, sourceRef, fetchImpl) {
  if (isSafeRemoteUrl(sourceRef)) {
    const response = await fetchImpl(sourceRef, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`campaign_source_http_${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  if (!sourceRef || String(sourceRef).includes('..')) throw new Error('campaign_source_invalid')
  const { data, error } = await supabase.storage.from('agent-files').download(String(sourceRef))
  if (error || !data) throw new Error(`campaign_source_download_failed:${error?.message ?? 'not_found'}`)
  return Buffer.from(await data.arrayBuffer())
}

function overlaySvg(width, height, variant) {
  const draft = variant === 'draft-a' || variant === 'draft-b'
  const accent = variant === 'draft-b' ? '#E07A5F' : '#D4AF37'
  const topOpacity = draft ? 0.08 : 0.04
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
      + `<rect width="${width}" height="${height}" fill="none"/>`
      + `<rect y="0" width="${width}" height="${Math.round(height * 0.035)}" fill="${accent}" opacity="${topOpacity}"/>`
      + `<rect y="${Math.round(height * 0.965)}" width="${width}" height="${Math.round(height * 0.035)}" fill="${accent}" opacity="${topOpacity}"/>`
      + '</svg>',
  )
}

export function buildBanglaCaption(product, recipe) {
  const name = String(product?.name ?? 'ALMA কালেকশন').trim().slice(0, 120)
  const code = String(product?.code ?? '').trim().slice(0, 50)
  const price = Math.max(0, Math.round(Number(product?.priceBdt ?? 0)))
  const tone = String(recipe?.captionTone ?? 'premium')
  const lead = tone === 'friendly'
    ? `আপনার পছন্দের ${name} এখন ALMA-তে।`
    : `${name} — পরিমিত সৌন্দর্য ও প্রিমিয়াম উপস্থিতির এক অনন্য মেলবন্ধন।`
  return [
    lead,
    code ? `প্রোডাক্ট কোড: ${code}` : '',
    price ? `মূল্য: ৳${price.toLocaleString('bn-BD')}` : '',
    'অর্ডারের জন্য ইনবক্স করুন।',
    '#ALMALifestyle #নতুনকালেকশন',
  ].filter(Boolean).join('\n')
}

export async function processCampaignPackStage({
  supabase,
  payload,
  fetchImpl = fetch,
}) {
  const meta = campaignMeta(payload)
  if (payload.operation === 'caption') {
    return {
      campaignPack: meta,
      captionBn: buildBanglaCaption(payload.product, payload.recipe),
      provider: 'local',
      engine: 'deterministic-bn-caption-v1',
      costUsd: 0,
      creativeStudio: true,
    }
  }

  if (payload.operation !== 'layout') throw new Error('campaign_pack_operation_invalid')
  const expected = CAMPAIGN_PACK_DIMENSIONS[meta.stageId]
  const width = Number(payload.width ?? expected?.width)
  const height = Number(payload.height ?? expected?.height)
  if (!expected || width !== expected.width || height !== expected.height) {
    throw new Error('campaign_pack_dimensions_invalid')
  }

  const source = await readSource(supabase, payload.sourceRef, fetchImpl)
  const variant = String(payload.variant ?? meta.stageId)
  const fit = variant === 'draft-a' ? 'contain' : 'cover'
  const position = variant === 'draft-b' ? 'attention' : 'centre'
  const image = await sharp(source)
    .rotate()
    .resize(width, height, {
      fit,
      position,
      background: { r: 245, g: 240, b: 232, alpha: 1 },
    })
    .composite([{ input: overlaySvg(width, height, variant), left: 0, top: 0 }])
    .jpeg({ quality: 91, mozjpeg: true })
    .toBuffer()

  const packId = safeSegment(meta.packId, 'pack')
  const stageId = safeSegment(meta.stageId, 'stage')
  const attempt = Math.max(1, Math.round(Number(meta.attempt)))
  const storagePath = `campaign-packs/${packId}/${stageId}-attempt-${attempt}.jpg`
  const { error } = await supabase.storage
    .from('agent-files')
    .upload(storagePath, image, {
      contentType: 'image/jpeg',
      upsert: true,
    })
  if (error) throw new Error(`campaign_pack_upload_failed:${error.message}`)

  return {
    campaignPack: meta,
    storagePath,
    provider: 'local',
    engine: 'sharp',
    width,
    height,
    variant,
    sourceRef: payload.sourceRef,
    costUsd: 0,
    creativeStudio: true,
  }
}
