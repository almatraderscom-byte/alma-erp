import { createHash } from 'node:crypto'

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function endpoint(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/api/assistant/internal/creative-studio/lifecycle`
}

async function responseJson(response) {
  return response.json().catch(() => ({}))
}

async function postResult({ appUrl, internalToken, fetchImpl, body }) {
  const response = await fetchImpl(endpoint(appUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${internalToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const payload = await responseJson(response)
  if (!response.ok) {
    throw new Error(`lifecycle result returned ${response.status}:${payload.error ?? 'unknown'}`)
  }
  return payload
}

function assertClaimSafe(job) {
  if (!job?.id || !job.leaseToken) throw new Error('lifecycle_claim_incomplete')
  if (job.status !== 'running') throw new Error('lifecycle_claim_not_running')
  if (job.effectClass !== 'zero_cost_local' || job.paidExecutionAllowed !== false) {
    throw new Error('paid_or_external_lifecycle_claim_rejected')
  }
  if (job.outputFormat !== 'json' || job.renderProfile !== 'composition-manifest-v1') {
    throw new Error('local_lifecycle_renderer_not_registered')
  }
  if (job.rendererVersion !== 'composition-manifest-v1') {
    throw new Error('local_lifecycle_renderer_version_mismatch')
  }
}

/**
 * The built-in adapter is a real, deterministic, zero-cost export. Rich media
 * renderers register beside it later; this worker never falls through to a
 * provider or claims a playable artifact without verification.
 */
export function renderCompositionManifest(job) {
  assertClaimSafe(job)
  const manifest = {
    schemaVersion: 1,
    kind: job.kind,
    compositionId: job.compositionId,
    compositionVersionId: job.compositionVersionId,
    compositionVersion: job.compositionVersion,
    compositionDocumentHash: job.compositionDocumentHash,
    operationBatchId: job.operationBatchId,
    sourceArtifactVersionId: job.sourceArtifactVersionId,
    approvedReviewEventId: job.approvedReviewEventId,
    approvedArtifactVersionId: job.approvedArtifactVersionId,
    reviewFingerprint: job.reviewFingerprint,
    renderFingerprint: job.renderFingerprint,
    document: job.compositionDocument,
  }
  const bytes = Buffer.from(`${stable(manifest)}\n`, 'utf8')
  return {
    bytes,
    checksum: sha256(bytes),
    operationPackageChecksum: sha256(Buffer.from(stable({
      compositionVersionId: job.compositionVersionId,
      operationBatchId: job.operationBatchId,
      renderFingerprint: job.renderFingerprint,
    }))),
    contentType: 'application/json',
    extension: 'json',
  }
}

export async function executeLifecycleClaim({
  job,
  appUrl,
  internalToken,
  supabase,
  fetchImpl = fetch,
  renderer = renderCompositionManifest,
}) {
  let storageEffectStarted = false
  try {
    assertClaimSafe(job)
    const artifact = await renderer(job)
    if (
      !Buffer.isBuffer(artifact?.bytes)
      || artifact.bytes.length === 0
      || !/^[a-f0-9]{64}$/.test(artifact.checksum)
      || sha256(artifact.bytes) !== artifact.checksum
    ) throw new Error('local_lifecycle_artifact_invalid')
    const storagePath = `creative-lifecycle/${job.id}/${job.renderFingerprint}.${artifact.extension}`
    storageEffectStarted = true
    const { error: uploadError } = await supabase.storage
      .from('agent-files')
      .upload(storagePath, artifact.bytes, {
        contentType: artifact.contentType,
        upsert: false,
      })
    if (uploadError) throw new Error(`lifecycle_upload_failed:${uploadError.message}`)
    const { data, error: downloadError } = await supabase.storage
      .from('agent-files')
      .download(storagePath)
    if (downloadError || !data) {
      throw new Error(`lifecycle_fetch_back_failed:${downloadError?.message ?? 'missing'}`)
    }
    const fetched = Buffer.from(await data.arrayBuffer())
    if (fetched.length !== artifact.bytes.length || sha256(fetched) !== artifact.checksum) {
      throw new Error('lifecycle_fetch_back_checksum_mismatch')
    }
    const result = await postResult({
      appUrl,
      internalToken,
      fetchImpl,
      body: {
        jobId: job.id,
        leaseToken: job.leaseToken,
        outcome: 'ready',
        storagePath,
        checksum: artifact.checksum,
        sizeBytes: artifact.bytes.length,
        operationPackageChecksum: artifact.operationPackageChecksum,
        renderStoragePath: storagePath,
      },
    })
    return { status: 'ready', job: result.job }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await postResult({
        appUrl,
        internalToken,
        fetchImpl,
        body: {
          jobId: job?.id,
          leaseToken: job?.leaseToken,
          outcome: 'failed',
          errorCode: message.split(':', 1)[0].slice(0, 120),
          errorMessage: message.slice(0, 2_000),
          ambiguousEffect: storageEffectStarted,
        },
      })
    } catch {
      // The lease expiry path in the app quarantines this claim. Never retry
      // here because an upload or callback may have taken effect.
    }
    return {
      status: storageEffectStarted ? 'needs_review' : 'failed',
      error: message,
      retryAllowed: false,
    }
  }
}

export async function runLifecycleWorkerTick({
  appUrl,
  internalToken,
  supabase,
  fetchImpl = fetch,
  enabled = process.env.STUDIO_LIFECYCLE_LOCAL_WORKER_ENABLED === 'true',
}) {
  if (!enabled) return { status: 'skipped', reason: 'lifecycle_worker_disabled', processed: 0 }
  if (!appUrl || !internalToken || !supabase) {
    return { status: 'skipped', reason: 'lifecycle_worker_configuration_missing', processed: 0 }
  }
  const response = await fetchImpl(`${endpoint(appUrl)}?limit=2`, {
    headers: { Authorization: `Bearer ${internalToken}` },
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await responseJson(response)
  if (!response.ok) {
    throw new Error(`lifecycle claim returned ${response.status}:${payload.error ?? 'unknown'}`)
  }
  const results = []
  for (const job of payload.jobs ?? []) {
    results.push(await executeLifecycleClaim({
      job,
      appUrl,
      internalToken,
      supabase,
      fetchImpl,
    }))
  }
  return { status: 'done', processed: results.length, results }
}

export function startLifecycleWorkerLoop({
  appUrl,
  internalToken,
  supabase,
  fetchImpl = fetch,
  intervalMs = 60_000,
}) {
  const tick = () => runLifecycleWorkerTick({
    appUrl,
    internalToken,
    supabase,
    fetchImpl,
    enabled: true,
  }).catch((error) => {
    console.error('[lifecycle-worker] tick failed:', error instanceof Error ? error.message : String(error))
  })
  void tick()
  return setInterval(tick, Math.max(30_000, Number(intervalMs) || 60_000))
}
