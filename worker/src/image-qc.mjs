/**
 * Designer QC gate — worker-side loop (calls app image-qc-score API).
 */

export const MAX_REGEN = 2

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

export async function scoreImageViaApi({ appUrl, token, storagePath, productType, productImagePath }) {
  const res = await fetch(`${appUrl}/api/assistant/internal/image-qc-score`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ storagePath, productType, productImagePath }),
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
}) {
  if (qcLevel === 'off') {
    return {
      storagePath: initialPath,
      qc: { pass: true, bypassed: true, attempts: 1, overall: 5 },
    }
  }

  const maxGenerations = MAX_REGEN + 1
  const attempts = []
  let currentPath = initialPath

  for (let i = 0; i < maxGenerations; i++) {
    const qc = await scoreImageViaApi({
      appUrl,
      token,
      storagePath: currentPath,
      productType,
      productImagePath,
    })
    attempts.push({
      storagePath: currentPath,
      pass: Boolean(qc.pass),
      score: qc.score,
      attempt: i + 1,
    })

    if (qc.pass) break
    if (i >= MAX_REGEN) break

    const fixHint = qc.score?.fix_hint ?? qc.score?.fail_reasons?.[0] ?? 'Improve garment fidelity and anatomy.'
    currentPath = await regenerate(fixHint, i + 2)
  }

  const best = attempts.reduce((a, b) => {
    const ao = a.score?.overall ?? 0
    const bo = b.score?.overall ?? 0
    return bo > ao ? b : a
  })

  let flagged
  if (!best.pass && attempts.length > 1) {
    const axes = [
      ['garment fidelity', best.score?.garment_fidelity],
      ['model', best.score?.model_preserved],
      ['anatomy', best.score?.anatomy],
      ['brand', best.score?.brand_consistency],
      ['text', best.score?.text_legibility],
      ['composition', best.score?.composition],
    ]
    axes.sort((x, y) => (x[1] ?? 5) - (y[1] ?? 5))
    flagged = `QC: best of ${attempts.length} — weak ${axes[0]?.[0]} (overall ${best.score?.overall}/5)`
  } else if (best.pass && attempts.length > 1) {
    flagged = `QC: passed on attempt ${best.attempt}`
  }

  return {
    storagePath: best.storagePath,
    qc: {
      pass: best.pass,
      attempts: attempts.length,
      overall: best.score?.overall,
      scores: attempts.map((a) => ({
        attempt: a.attempt,
        overall: a.score?.overall,
        pass: a.pass,
      })),
      flagged,
    },
  }
}
