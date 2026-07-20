/**
 * G08 / SPEC-073 — Deterministic side-effect seed.
 *
 * Derives a tool's side-effect set from its (mode, domain, risk) triple. This is
 * the SEED used by the domain-manifest generator so every generated manifest has
 * a valid, non-empty `sideEffects`. SPEC-075 builds the authoritative policy
 * mapping on top of these kinds and a test that the seeds stay consistent.
 *
 * Deterministic pure function. No I/O, no LLM.
 */
import type { ManifestMode, ManifestRisk, SideEffectKind } from './manifest.schema'

/** Domains whose write/stage tools message external people. */
const MESSAGING_DOMAINS = new Set(['wa', 'cs', 'family', 'calls', 'social', 'coworker'])
/** Domains whose write/stage tools call an external marketing/API surface. */
const EXTERNAL_API_DOMAINS = new Set(['meta_ads', 'ads', 'gbp', 'seo', 'growth', 'campaign', 'website', 'analytics', 'competitor'])
/** Domains that move money. */
const MONEY_DOMAINS = new Set(['finance', 'erp', 'bills', 'trading', 'cost'])
/** Domains that invoke a generative model. */
const MODEL_DOMAINS = new Set(['studio', 'creative', 'tryon', 'vision', 'content', 'brand', 'qc'])
/** Domains that drive a browser. */
const BROWSER_DOMAINS = new Set(['live_browser', 'browser'])
/** Domains that write files / documents. */
const FILE_DOMAINS = new Set(['documents', 'artifacts'])
/** Domains that schedule future work. */
const SCHEDULE_DOMAINS = new Set(['reminders', 'appointments', 'dates'])
/** Domains that push device notifications. */
const PUSH_DOMAINS = new Set(['push'])

export function deriveSideEffects(
  mode: ManifestMode,
  domain: string,
  risk: ManifestRisk,
): SideEffectKind[] {
  if (mode === 'read') return ['db_read']

  const out = new Set<SideEffectKind>(['db_write'])
  if (MESSAGING_DOMAINS.has(domain)) out.add('external_message')
  if (EXTERNAL_API_DOMAINS.has(domain)) out.add('external_api_write')
  if (MODEL_DOMAINS.has(domain)) out.add('model_invocation')
  if (BROWSER_DOMAINS.has(domain)) out.add('browser_action')
  if (FILE_DOMAINS.has(domain)) out.add('file_write')
  if (SCHEDULE_DOMAINS.has(domain)) out.add('schedule')
  if (PUSH_DOMAINS.has(domain)) out.add('push_notification')
  if (MONEY_DOMAINS.has(domain) && risk === 'high') out.add('money_movement')

  // Deterministic order: keep the frozen enum order for diff-stability.
  const ORDER: SideEffectKind[] = [
    'none', 'db_read', 'db_write', 'external_message', 'external_api_write',
    'money_movement', 'file_write', 'browser_action', 'model_invocation',
    'schedule', 'push_notification',
  ]
  return ORDER.filter((k) => out.has(k))
}
