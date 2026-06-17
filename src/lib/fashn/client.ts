import type { FashnModelName, FashnRunOptions, FashnRunResponse, FashnStatusResponse } from '@/lib/fashn/types'

const FASHN_BASE = 'https://api.fashn.ai/v1'

export function isFashnConfigured(): boolean {
  const key = process.env.FASHN_API_KEY?.trim()
  return Boolean(key && key.length > 10 && !/^REPLACE_|YOUR_/i.test(key))
}

function getApiKey(): string {
  const key = process.env.FASHN_API_KEY?.trim()
  if (!isFashnConfigured() || !key) throw new Error('FASHN_API_KEY not configured')
  return key
}

export async function fashnRun(
  modelName: FashnModelName,
  inputs: Record<string, unknown>,
  opts?: FashnRunOptions,
): Promise<FashnRunResponse> {
  const body: Record<string, unknown> = {
    model_name: modelName,
    inputs: {
      ...inputs,
      ...(opts?.prompt ? { prompt: opts.prompt } : {}),
      ...(opts?.resolution ? { resolution: opts.resolution } : {}),
      ...(opts?.generationMode ? { generation_mode: opts.generationMode } : {}),
      ...(opts?.numImages ? { num_images: opts.numImages } : {}),
      ...(opts?.outputFormat ? { output_format: opts.outputFormat } : {}),
      ...(opts?.returnBase64 !== undefined ? { return_base64: opts.returnBase64 } : {}),
      ...(opts?.faceReference ? { face_reference: opts.faceReference } : {}),
    },
  }

  const res = await fetch(`${FASHN_BASE}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  const data = (await res.json().catch(() => ({}))) as FashnRunResponse & { message?: string }
  if (!res.ok) {
    throw new Error(data.error ?? data.message ?? `FASHN run failed HTTP ${res.status}`)
  }
  if (!data.id) throw new Error('FASHN run missing prediction id')
  return data
}

export async function fashnStatus(predictionId: string): Promise<FashnStatusResponse> {
  const res = await fetch(`${FASHN_BASE}/status/${encodeURIComponent(predictionId)}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    signal: AbortSignal.timeout(20_000),
  })
  const data = (await res.json().catch(() => ({}))) as FashnStatusResponse & { message?: string }
  if (!res.ok) {
    throw new Error(data.error ?? data.message ?? `FASHN status failed HTTP ${res.status}`)
  }
  return data
}

/** Poll until completed or failed (max ~3 min). */
export async function fashnPollUntilDone(
  predictionId: string,
  opts?: { maxMs?: number; intervalMs?: number },
): Promise<FashnStatusResponse> {
  const maxMs = opts?.maxMs ?? 180_000
  const intervalMs = opts?.intervalMs ?? 4_000
  const started = Date.now()

  while (Date.now() - started < maxMs) {
    const st = await fashnStatus(predictionId)
    if (st.status === 'completed') return st
    if (st.status === 'failed') throw new Error(st.error ?? 'FASHN generation failed')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('FASHN generation timed out')
}
