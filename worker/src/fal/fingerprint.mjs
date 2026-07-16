/**
 * CS5 — deterministic input fingerprint for Fal jobs (idempotency key).
 * Same endpoint + same logical input → same fingerprint, regardless of key
 * order, so a restarted worker can recognise "this exact paid request was
 * already submitted" and resume instead of paying again.
 */
import { createHash } from 'node:crypto'

/** JSON.stringify with recursively sorted object keys (arrays keep order). */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const keys = Object.keys(value).sort()
  const body = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')
  return `{${body}}`
}

/**
 * @param {string} endpointId
 * @param {object} input — the exact payload sent to Fal
 * @returns {string} sha256 hex fingerprint
 */
export function falInputFingerprint(endpointId, input) {
  return createHash('sha256')
    .update(`${endpointId}\n${stableStringify(input ?? {})}`)
    .digest('hex')
}
