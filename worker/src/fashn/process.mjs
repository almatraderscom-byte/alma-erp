/**
 * FASHN image generation for Creative Studio jobs.
 */
import {
  fashnRun,
  fashnPollUntilDone,
  resolveFashnImageInputs,
  downloadFashnOutputToStorage,
} from './client.mjs'

export async function processFashnImageGen({ supabase, pendingActionId, payload, logCost }) {
  const { fashnModel, fashnInputs, fashnOptions } = payload
  if (!fashnModel) throw new Error('fashnModel missing')

  const inputs = await resolveFashnImageInputs(supabase, fashnInputs)
  const run = await fashnRun(fashnModel, inputs, {
    prompt: fashnOptions?.prompt,
    resolution: fashnOptions?.resolution ?? '2k',
    generationMode: fashnOptions?.generationMode ?? 'balanced',
    numImages: 1,
    outputFormat: fashnOptions?.outputFormat ?? 'png',
  })

  console.log(`[worker] fashn ${pendingActionId} — prediction ${run.id}`)
  const done = await fashnPollUntilDone(run.id)
  const outputs = done.output ?? []
  if (!outputs.length) throw new Error('FASHN empty output')

  const paths = []
  for (let i = 0; i < outputs.length; i++) {
    const url = outputs[i]
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) continue
      const buf = Buffer.from(match[2], 'base64')
      const ext = match[1].includes('jpeg') ? 'jpg' : 'png'
      const storagePath = `generated/studio-${pendingActionId}${i ? `-${i}` : ''}.${ext}`
      await supabase.storage.from('agent-files').upload(storagePath, buf, {
        contentType: match[1],
        upsert: true,
      })
      paths.push(storagePath)
    } else {
      paths.push(await downloadFashnOutputToStorage(supabase, url, pendingActionId, i))
    }
  }

  const credits = fashnOptions?.resolution === '4k' ? 4 : fashnOptions?.resolution === '2k' ? 3 : 2
  void logCost({
    provider: 'fashn',
    kind: 'image',
    units: { model: fashnModel, resolution: fashnOptions?.resolution, credits },
    costUsd: credits * 0.075,
    jobId: pendingActionId,
    dedupKey: `fashn:${pendingActionId}`,
  })

  return { storagePath: paths[0], allPaths: paths, provider: 'fashn' }
}
