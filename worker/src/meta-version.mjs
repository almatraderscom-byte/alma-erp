/**
 * Phase 63 — worker mirror of the canonical Meta Graph version resolver
 * (src/lib/meta-version.ts). Worker .mjs files cannot import TS, so this holds
 * the SAME default and the same env override. Keep this default in lock-step
 * with META_GRAPH_DEFAULT_VERSION on the TS side; NEVER blind-bump — check the
 * official changelog first.
 */

/** The version the codebase is contract-tested against (mirror of TS default). */
export const META_GRAPH_DEFAULT_VERSION = 'v21.0'

const VERSION_RE = /^v\d{2}\.\d$/

/** Resolve the Graph version: validated env override or the tested default. */
export function metaGraphVersion() {
  const env = process.env.META_GRAPH_VERSION?.trim()
  if (env) {
    if (VERSION_RE.test(env)) return env
    console.warn(`[meta-version] ignoring invalid META_GRAPH_VERSION "${env}" — using ${META_GRAPH_DEFAULT_VERSION}`)
  }
  return META_GRAPH_DEFAULT_VERSION
}

/** e.g. https://graph.facebook.com/v21.0 */
export function metaGraphBase() {
  return `https://graph.facebook.com/${metaGraphVersion()}`
}
