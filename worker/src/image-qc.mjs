/**
 * Designer QC gate — worker-side loop (calls app image-qc-score API).
 */

export const MAX_REGEN = 2

// CS8 — production hard gate (mirrors src/lib/tryon/qc-gate.ts, keep in sync):
// garment fidelity, model identity and anatomy must EACH be ≥4/5 in
// production mode — a good overall can no longer carry a 2/5 axis.
export const PRODUCTION_MIN_CORE_AXIS = 4

export function productionCoreAxesPass(score) {
  return (
    Number(score?.garment_fidelity ?? 0) >= PRODUCTION_MIN_CORE_AXIS
    && Number(score?.model_preserved ?? 0) >= PRODUCTION_MIN_CORE_AXIS
    && Number(score?.anatomy ?? 0) >= PRODUCTION_MIN_CORE_AXIS
  )
}

export async function fetchQcLevel(supabase) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', 'agent_qc_level')
    .maybeSingle()
  const v = data?.value?.trim()?.toLowerCase()
  if (v === 'off' || v === 'strict' || v === 'normal') return v
  return 'normal'
}

/** CS8 — owner-tunable Preview/Production pipeline mode (kv, default preview). */
export async function fetchPipelineMode(supabase) {
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', 'cs_pipeline_mode')
      .maybeSingle()
    return data?.value?.trim()?.toLowerCase() === 'production' ? 'production' : 'preview'
  } catch {
    return 'preview'
  }
}

export async function scoreImageViaApi({ appUrl, token, storagePath, productType, productImagePath, surface }) {
  const res = await fetch(`${appUrl}/api/assistant/internal/image-qc-score`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    // CS10 — surface selects mode-specific thresholds server-side
    body: JSON.stringify({ storagePath, productType, productImagePath, surface }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`QC score HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * Run bounded QC loop after initial generation.
 * @returns best attempt metadata for job-result
 */
export async function runImageQcLoop({
  supabase,
  appUrl,
  token,
  qcLevel,
  initialPath,
  productType,
  productImagePath,
  regenerate,
  /** CS10 — surface-specific thresholds ('single_tryon' | 'family' | …) */
  surface,
}) {
  if (qcLevel === 'off') {
    return {
      storagePath: initialPath,
      qc: { pass: true, bypassed: true, attempts: 1, overall: 5 },
    }
  }

  // CS8 — the pipeline mode bounds paid work for EVERY engine that runs this
  // loop (FASHN, Gemini, fal VTON): preview = score once, NO paid regen;
  // production = bounded regens + hard core-axis gate on pass/fail.
  const pipelineMode = await fetchPipelineMode(supabase)
  const maxGenerations = pipelineMode === 'preview' ? 1 : MAX_REGEN + 1
  const attempts = []
  let currentPath = initialPath

  for (let i = 0; i < maxGenerations; i++) {
    // QC FAIL-OPEN (2026-07-12): the scorer rides Gemini vision — when that is
    // down (e.g. Google prepaid credits depleted → 429) the render itself may
    // be perfectly fine. A dead QC must never kill a paid, finished image:
    // deliver what we have, flagged so the owner knows QC was skipped.
    let qc
    try {
      qc = await scoreImageViaApi({
        appUrl,
        token,
        storagePath: currentPath,
        productType,
        productImagePath,
        surface,
      })
    } catch (err) {
      console.warn('[image-qc] scorer unavailable — delivering unscored:', err?.message ?? err)
      return {
        storagePath: currentPath,
        qc: {
          pass: true,
          attempts: attempts.length + 1,
          skipped: 'qc_unavailable',
          flagged: 'QC চালানো যায়নি (ভিশন API ডাউন) — ছবি আন-চেকড ডেলিভার হয়েছে',
        },
      }
    }
    // CS8 — in production the hard core-axis gate overrides a lenient overall
    // pass: any core axis below 4/5 fails the attempt.
    const axisOk = pipelineMode === 'production' ? productionCoreAxesPass(qc.score) : true
    attempts.push({
      storagePath: currentPath,
      pass: Boolean(qc.pass) && axisOk,
      score: qc.score,
      attempt: i + 1,
    })

    if (attempts[attempts.length - 1].pass) break
    if (i >= maxGenerations - 1) break

    const fixHint = qc.score?.fix_hint ?? qc.score?.fail_reasons?.[0] ?? 'Improve garment fidelity and anatomy.'
    currentPath = await regenerate(fixHint, i + 2)
  }

  // Best attempt by weighted core axes first, overall second — never "overall
  // alone" (roadmap CS8: select best by weighted score).
  const weightOf = (a) => {
    const s = a.score ?? {}
    const core = (Number(s.garment_fidelity ?? 0) + Number(s.model_preserved ?? 0) + Number(s.anatomy ?? 0)) * 2
    return core + Number(s.overall ?? 0)
  }
  const best = attempts.reduce((a, b) => (weightOf(b) > weightOf(a) ? b : a))

  let flagged
  if (!best.pass) {
    const axes = [
      ['garment fidelity', best.score?.garment_fidelity],
      ['model', best.score?.model_preserved],
      ['anatomy', best.score?.anatomy],
      ['brand', best.score?.brand_consistency],
      ['text', best.score?.text_legibility],
      ['composition', best.score?.composition],
    ]
    axes.sort((x, y) => (x[1] ?? 5) - (y[1] ?? 5))
    flagged = pipelineMode === 'preview' && attempts.length === 1
      ? `প্রিভিউ মোড: QC ${best.score?.overall ?? '?'}/৫ — প্রোডাকশনে চালালে কড়া যাচাই হবে`
      : `QC: best of ${attempts.length} — weak ${axes[0]?.[0]} (overall ${best.score?.overall}/5)`
  } else if (best.pass && attempts.length > 1) {
    flagged = `QC: passed on attempt ${best.attempt}`
  }

  return {
    storagePath: best.storagePath,
    qc: {
      pass: best.pass,
      attempts: attempts.length,
      pipelineMode,
      overall: best.score?.overall,
      coreAxes: {
        garment_fidelity: best.score?.garment_fidelity,
        model_preserved: best.score?.model_preserved,
        anatomy: best.score?.anatomy,
      },
      scores: attempts.map((a) => ({
        attempt: a.attempt,
        overall: a.score?.overall,
        pass: a.pass,
      })),
      flagged,
    },
  }
}
