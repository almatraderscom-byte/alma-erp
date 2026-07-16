export const CLIENT_SEO_BATCH_KIND = 'client_seo_batch'
export const MIN_LIVE_BROWSER_PAGES = 5

export interface ClientSeoTargetState {
  url: string
  browserPages: Array<{ url: string; screenshotUrl?: string }>
  awaitingBrowserLook: boolean
  auditActionId?: string
  auditStatus: 'pending' | 'queued' | 'executed' | 'failed'
  reportDelivered: boolean
  linksDelivered: boolean
  /**
   * 2026-07-16 live incident: a target that 301s into ANOTHER listed target
   * (gulshanspaone.com → queenspabd.com) can never produce its own browser
   * pages — the old guard deadlocked the agent demanding them. When set, this
   * target's browser requirement is satisfied by the redirect observation.
   */
  redirectsToHost?: string
}

export interface ClientSeoBatchFacts {
  version: 1
  requireLiveBrowser: boolean
  requireArtifact: boolean
  currentIndex: number
  targets: ClientSeoTargetState[]
  packCompleted: boolean
}

export type ClientSeoBatchEvent =
  | { type: 'browser_act' }
  | { type: 'browser_look'; url: string; screenshotUrl?: string }
  | { type: 'audit_queued'; actionId: string }
  | { type: 'audit_finished'; actionId: string; ok: boolean }
  | { type: 'report_read'; actionId?: string }
  | { type: 'links_read'; actionId?: string }
  | { type: 'pack_completed' }

export function createClientSeoBatchFacts(
  targets: string[],
  opts: { requireLiveBrowser: boolean; requireArtifact: boolean },
): ClientSeoBatchFacts {
  return {
    version: 1,
    requireLiveBrowser: opts.requireLiveBrowser,
    requireArtifact: opts.requireArtifact,
    currentIndex: 0,
    targets: targets.map((url) => ({
      url,
      browserPages: [],
      awaitingBrowserLook: false,
      auditStatus: 'pending',
      reportDelivered: false,
      linksDelivered: false,
    })),
    packCompleted: false,
  }
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, '')
  } catch {
    return false
  }
}

function targetIndexForAction(facts: ClientSeoBatchFacts, actionId?: string): number {
  if (actionId) {
    const idx = facts.targets.findIndex((t) => t.auditActionId === actionId)
    if (idx >= 0) return idx
  }
  return Math.min(facts.currentIndex, Math.max(0, facts.targets.length - 1))
}

export function clientSeoBatchRequiredTool(facts: ClientSeoBatchFacts): string | null {
  if (facts.packCompleted) return null
  const target = facts.targets[facts.currentIndex]
  if (!target) return 'complete_skill_pack_run'
  // A redirect-collapsed target has no pages of its own — the redirect IS the
  // browser observation (2026-07-16 incident fix).
  if (
    facts.requireLiveBrowser
    && !target.redirectsToHost
    && target.browserPages.length < MIN_LIVE_BROWSER_PAGES
  ) {
    return target.awaitingBrowserLook ? 'live_browser_look' : 'live_browser_act'
  }
  if (target.auditStatus === 'pending') return 'run_website_seo_audit'
  if (target.auditStatus === 'queued') return null
  if (target.auditStatus === 'failed') return null
  if (!target.reportDelivered) return 'check_website_seo_audit'
  if (!target.linksDelivered) return 'check_website_seo_audit'
  return facts.currentIndex < facts.targets.length - 1 ? 'live_browser_act' : 'complete_skill_pack_run'
}

export function clientSeoBatchStateLabel(facts: ClientSeoBatchFacts): string {
  if (facts.packCompleted) return 'completed'
  const target = facts.targets[facts.currentIndex]
  if (!target) return 'pack_completion'
  const n = facts.currentIndex + 1
  if (facts.requireLiveBrowser && target.browserPages.length < MIN_LIVE_BROWSER_PAGES) return `target_${n}_browser_walk`
  if (target.auditStatus === 'pending') return `target_${n}_audit_queue`
  if (target.auditStatus === 'queued') return `target_${n}_audit_running`
  if (target.auditStatus === 'failed') return `target_${n}_audit_failed`
  if (!target.reportDelivered) return `target_${n}_report`
  if (!target.linksDelivered) return `target_${n}_links`
  return facts.currentIndex < facts.targets.length - 1 ? `target_${n + 1}_browser_walk` : 'pack_completion'
}

export function reduceClientSeoBatch(
  facts: ClientSeoBatchFacts,
  event: ClientSeoBatchEvent,
): ClientSeoBatchFacts {
  const next: ClientSeoBatchFacts = JSON.parse(JSON.stringify(facts))
  const idx = 'actionId' in event ? targetIndexForAction(next, event.actionId) : next.currentIndex
  const target = next.targets[idx]
  if (!target && event.type !== 'pack_completed') return next

  if (event.type === 'browser_act') {
    target.awaitingBrowserLook = true
  } else if (event.type === 'browser_look') {
    if (sameHost(target.url, event.url) && !target.browserPages.some((p) => p.url === event.url)) {
      target.browserPages.push({ url: event.url, ...(event.screenshotUrl ? { screenshotUrl: event.screenshotUrl } : {}) })
    } else if (!sameHost(target.url, event.url)) {
      // 2026-07-16 incident: navigating the CURRENT target landed on ANOTHER
      // listed target's host → the current domain redirects into it. Record
      // the collapse (waives this target's browser requirement) and credit
      // the observed page to the target it actually belongs to.
      const ownerIdx = next.targets.findIndex((t) => sameHost(t.url, event.url))
      if (ownerIdx >= 0) {
        if (target.browserPages.length === 0 && ownerIdx !== idx) {
          try { target.redirectsToHost = new URL(event.url).hostname.replace(/^www\./, '') } catch { /* keep unset */ }
        }
        const ownerTarget = next.targets[ownerIdx]
        if (!ownerTarget.browserPages.some((p) => p.url === event.url)) {
          ownerTarget.browserPages.push({ url: event.url, ...(event.screenshotUrl ? { screenshotUrl: event.screenshotUrl } : {}) })
        }
      }
    }
    target.awaitingBrowserLook = false
  } else if (event.type === 'audit_queued') {
    target.auditActionId = event.actionId
    target.auditStatus = 'queued'
  } else if (event.type === 'audit_finished') {
    target.auditStatus = event.ok ? 'executed' : 'failed'
  } else if (event.type === 'report_read') {
    target.reportDelivered = true
  } else if (event.type === 'links_read') {
    target.linksDelivered = true
    if (idx === next.currentIndex && idx < next.targets.length - 1) next.currentIndex = idx + 1
  } else if (event.type === 'pack_completed') {
    next.packCompleted = true
  }
  return next
}

export function clientSeoBatchIsReadyForPack(facts: ClientSeoBatchFacts): boolean {
  return facts.targets.length > 0 && facts.targets.every((t) =>
    (!facts.requireLiveBrowser || Boolean(t.redirectsToHost) || t.browserPages.length >= MIN_LIVE_BROWSER_PAGES)
    && t.auditStatus === 'executed'
    && t.reportDelivered
    && t.linksDelivered,
  )
}
