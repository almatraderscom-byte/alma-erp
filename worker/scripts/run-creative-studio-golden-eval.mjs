/**
 * CS10 — golden-set evaluation runner.
 *
 * For each golden case × engine (Direct FASHN / Fal FASHN v1.6 / IDM-VTON):
 * ONE raw generation (fixed seed where the engine supports it), scored through
 * the same QC rubric with single_tryon surface thresholds. Every attempt is
 * persisted to agent_kv_settings (cs_eval:<runId>:<case>:<engine>) so a
 * crashed/restarted run RESUMES — finished attempts are never re-paid.
 *
 * Runs as a worker job (payload.provider === 'golden_eval' from the
 * evaluations route) or standalone: node scripts/run-creative-studio-golden-eval.mjs '<json>'
 */
import {
  runFalQueueJob,
  storagePathToNormalizedDataUri,
  downloadFalOutputToStorage,
  extractFalImageUrl,
  clearFalRequestState,
} from '../src/fal/client.mjs'
import { falInputFingerprint } from '../src/fal/fingerprint.mjs'
import { buildCatVtonInput, CAT_VTON_ENDPOINT } from '../src/fal/adapters/cat-vton.mjs'
import { buildFashnV16Input, resolveFashnCategory, FASHN_V16_ENDPOINT } from '../src/fal/adapters/fashn-v16.mjs'
import { scoreImageViaApi } from '../src/image-qc.mjs'

const attemptKey = (runId, caseId, engine) => `cs_eval:${runId}:${caseId}:${engine}`

async function readKvJson(supabase, key) {
  const { data } = await supabase.from('agent_kv_settings').select('value').eq('key', key).maybeSingle()
  if (!data?.value) return null
  try { return JSON.parse(data.value) } catch { return null }
}

async function writeKvJson(supabase, key, obj) {
  await supabase.from('agent_kv_settings').upsert({ key, value: JSON.stringify(obj) }, { onConflict: 'key' })
}

/** One raw generation on the requested engine — returns {storagePath, requestId, seed, costUsd}. */
async function generateOnce({ supabase, engine, evalActionId, cse }) {
  const t0 = Date.now()
  if (engine === 'fashn') {
    const { fashnRun, fashnPollUntilDone, resolveFashnImageInputs, downloadFashnOutputToStorage } = await import('../src/fashn/client.mjs')
    const inputs = await resolveFashnImageInputs(supabase, {
      model_image: cse.modelImagePath,
      product_image: cse.productImagePath,
    })
    const run = await fashnRun('tryon-max', inputs, {
      resolution: '2k',
      generationMode: 'balanced',
      numImages: 1,
      outputFormat: 'png',
    })
    const done = await fashnPollUntilDone(run.id)
    const outputs = done.output ?? []
    if (!outputs.length) throw new Error('FASHN empty output')
    const storagePath = await downloadFashnOutputToStorage(supabase, outputs[0], evalActionId, 0)
    return { storagePath, requestId: run.id, seed: null, costUsd: 0.225, latencyMs: Date.now() - t0 }
  }

  const [modelUri, garmentUri] = await Promise.all([
    storagePathToNormalizedDataUri(supabase, cse.modelImagePath),
    storagePathToNormalizedDataUri(supabase, cse.productImagePath),
  ])
  const endpointId = engine === 'fal_idm_vton' ? CAT_VTON_ENDPOINT : FASHN_V16_ENDPOINT
  const input = engine === 'fal_idm_vton'
    ? buildCatVtonInput({
        humanDataUri: modelUri,
        garmentDataUri: garmentUri,
        clothType: cse.clothType ?? 'overall',
        seed: cse.seed,
      })
    : buildFashnV16Input({
        modelDataUri: modelUri,
        garmentDataUri: garmentUri,
        category: resolveFashnCategory({ clothType: cse.clothType, fashnCategory: cse.fashnCategory }),
        mode: 'balanced',
        seed: cse.seed,
      })
  const out = await runFalQueueJob({
    supabase,
    pendingActionId: evalActionId,
    endpointId,
    input,
    inputFingerprint: falInputFingerprint(endpointId, {
      caseId: cse.id,
      modelImagePath: cse.modelImagePath,
      productImagePath: cse.productImagePath,
      seed: cse.seed ?? null,
      purpose: 'golden_eval',
    }),
  })
  const url = extractFalImageUrl(out.payload)
  if (!url) throw new Error(`${engine}: no image in fal result`)
  const storagePath = await downloadFalOutputToStorage(supabase, url, evalActionId)
  await clearFalRequestState(supabase, evalActionId)
  return {
    storagePath,
    requestId: out.requestId,
    seed: out.payload?.seed ?? cse.seed ?? null,
    costUsd: engine === 'fal_fashn_v16' ? 0.075 : 0.05,
    latencyMs: out.latencyMs,
  }
}

/**
 * @param {object} args {supabase, pendingActionId, payload:{runId, cases[], engines[]}, logCost, appUrl, token}
 * @returns report object (also persisted to kv cs_eval_report:<runId>)
 */
export async function runGoldenEval({ supabase, pendingActionId, payload, logCost, appUrl, token }) {
  const runId = payload.runId
  const cases = payload.cases ?? []
  const engines = payload.engines?.length ? payload.engines : ['fashn', 'fal_fashn_v16', 'fal_idm_vton']
  if (!runId || !cases.length) throw new Error('golden_eval needs runId + cases')

  const attempts = []
  for (const cse of cases) {
    for (const engine of engines) {
      const key = attemptKey(runId, cse.id, engine)
      const existing = await readKvJson(supabase, key)
      if (existing) {
        attempts.push(existing) // resume — never re-pay a finished attempt
        continue
      }
      const evalActionId = `eval-${runId}-${cse.id}-${engine}`.slice(0, 60)
      let attempt
      try {
        console.log(`[golden-eval] ${runId} — ${cse.id} × ${engine}`)
        const gen = await generateOnce({ supabase, engine, evalActionId, cse })
        let scored = null
        try {
          scored = await scoreImageViaApi({
            appUrl,
            token,
            storagePath: gen.storagePath,
            productType: cse.garmentType ?? null,
            productImagePath: cse.productImagePath,
            surface: 'single_tryon',
          })
        } catch (err) {
          console.warn(`[golden-eval] scoring failed for ${cse.id}×${engine}: ${err.message}`)
        }
        attempt = {
          caseId: cse.id,
          engine,
          storagePath: gen.storagePath,
          requestId: gen.requestId,
          seed: gen.seed,
          latencyMs: gen.latencyMs,
          costUsd: gen.costUsd,
          score: scored?.score,
          pass: Boolean(scored?.pass),
          error: scored ? undefined : 'qc_unavailable',
        }
        void logCost({
          provider: engine === 'fashn' ? 'fashn' : 'fal',
          kind: 'image',
          units: { purpose: 'golden_eval', runId, caseId: cse.id, engine },
          costUsd: gen.costUsd,
          jobId: pendingActionId,
          dedupKey: `eval:${runId}:${cse.id}:${engine}`,
        })
      } catch (err) {
        attempt = { caseId: cse.id, engine, latencyMs: 0, costUsd: 0, pass: false, error: err.message?.slice(0, 200) }
        console.warn(`[golden-eval] ${cse.id} × ${engine} FAILED: ${err.message}`)
      }
      await writeKvJson(supabase, key, attempt)
      attempts.push(attempt)
    }
  }

  const report = {
    runId,
    finishedAt: new Date().toISOString(),
    cases: cases.map((c) => ({ id: c.id, garmentType: c.garmentType })),
    engines,
    attempts,
    totalCostUsd: Math.round(attempts.reduce((s, a) => s + (a.costUsd || 0), 0) * 1000) / 1000,
  }
  await writeKvJson(supabase, `cs_eval_report:${runId}`, report)
  return report
}

// ── standalone CLI (owner/admin use over ssh) ─────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createClient } = await import('@supabase/supabase-js')
  const { logCost } = await import('../src/cost-log.mjs')
  const { getAppUrl, getInternalToken } = await import('../src/env.mjs')
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const payload = JSON.parse(process.argv[2] ?? '{}')
  const report = await runGoldenEval({
    supabase,
    pendingActionId: `cli-${payload.runId ?? 'manual'}`,
    payload,
    logCost,
    appUrl: getAppUrl(),
    token: getInternalToken(),
  })
  console.log(JSON.stringify(report, null, 2))
}
