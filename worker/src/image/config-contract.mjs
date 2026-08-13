import { createHash } from 'node:crypto'
import {
  IMAGE_PRESET_ASPECTS,
  resolveGenericImageRequest,
} from '../image-resolution-contract.mjs'

/**
 * Build 103 Issue 2 — worker-side verification of the canonical v2 image
 * config. The server derived and pinned it at approval; this process must
 * independently re-derive the fingerprint AND the exact dimensions before any
 * paid provider call. A mismatch is a contract violation and fails closed —
 * never a silent downgrade.
 *
 * The fingerprint algorithm mirrors src/agent/lib/image-config-contract.ts
 * exactly (parity-tested from the server suite).
 */

export const IMAGE_RENDER_CONFIG_VERSION = 1

export function imageConfigFingerprint(model, config) {
  const canonical = JSON.stringify([
    'alma-image-config-v1',
    model,
    config.version,
    config.presetId,
    config.sizeMode,
    config.aspectRatio,
    config.imageSize,
    config.width,
    config.height,
    config.quality,
    config.providerQuality,
    config.variationCount,
    config.pipelineMode,
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Returns a human-readable failure reason, or null when the payload's
 * canonical config, its mirror fields, and this worker's own audited
 * resolution tables all agree. Legacy payloads without imageConfig skip this
 * entirely (v1 path).
 */
export function verifyImageConfigPayload(payload) {
  const config = payload?.imageConfig
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'image config verification: canonical config missing or malformed'
  }
  if (config.version !== IMAGE_RENDER_CONFIG_VERSION) {
    return `image config verification: unsupported config version ${config.version}`
  }
  const model = typeof payload.imageModel === 'string' ? payload.imageModel : null
  if (!model) return 'image config verification: pinned image model missing'
  const expectedAspect = IMAGE_PRESET_ASPECTS[config.presetId]
  if (!expectedAspect) {
    return `image config verification: unknown preset ${config.presetId}`
  }
  if (config.aspectRatio !== expectedAspect) {
    return `image config verification: preset ${config.presetId} does not map to ${config.aspectRatio}`
  }
  const fingerprint = imageConfigFingerprint(model, config)
  if (payload.imageConfigFingerprint !== fingerprint) {
    return 'image config verification: fingerprint mismatch — the approved selection and the queued payload diverged'
  }
  // Mirror fields must agree with the canonical config: the provider request
  // below is built from the mirror, so any divergence would render something
  // the owner did not approve.
  if (payload.aspectRatio !== config.aspectRatio) {
    return 'image config verification: payload aspectRatio diverged from canonical config'
  }
  if (payload.imageSize !== config.imageSize) {
    return 'image config verification: payload imageSize diverged from canonical config'
  }
  if (Number(payload.variationCount ?? 1) !== config.variationCount) {
    return 'image config verification: payload variationCount diverged from canonical config'
  }
  if (payload.quality !== config.quality) {
    return 'image config verification: payload quality diverged from canonical config'
  }
  // Re-derive the exact dimensions from THIS worker's audited tables and
  // require equality with the server-resolved values pinned at approval.
  let resolved
  try {
    resolved = resolveGenericImageRequest({
      modelName: model,
      imageSize: config.imageSize,
      aspectRatio: config.aspectRatio,
    })
  } catch (err) {
    return `image config verification: ${err.message}`
  }
  const dims = resolved.dimensions
  if (!dims || dims.width !== config.width || dims.height !== config.height) {
    return `image config verification: dimensions mismatch — config ${config.width}x${config.height}, worker resolves ${dims?.width}x${dims?.height}`
  }
  return null
}
