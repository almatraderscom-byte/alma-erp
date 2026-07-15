/**
 * Deterministic requirements extracted from the OWNER'S message.
 *
 * These are control state, not prompt suggestions.  The model may choose how to
 * perform the work, but it may not silently drop an explicitly requested
 * surface (for example the owner's live Chrome) or one of an ordered list of
 * targets.
 */

export interface OwnerTurnRequirements {
  liveBrowser: boolean
  clientSeo: boolean
  reportArtifact: boolean
  remember: boolean
  targets: string[]
}

const DOMAIN_RE = /(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,})+)(?:\/[^\s,;]*)?/gi

function normalizeTarget(host: string): string {
  return `https://${host.toLowerCase().replace(/^www\./, '')}`
}

export function extractOrderedWebTargets(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(DOMAIN_RE)) {
    const target = normalizeTarget(match[1])
    if (!seen.has(target)) {
      seen.add(target)
      out.push(target)
    }
  }
  return out
}

export function deriveOwnerTurnRequirements(text: string): OwnerTurnRequirements {
  const t = text.trim()
  const targets = extractOrderedWebTargets(t)
  const liveBrowser = /\blive[\s_-]*browser\b|আমার\s*(?:chrome|ক্রোম|browser|ব্রাউজার)|(?:chrome|ক্রোম|browser|ব্রাউজার)\s*(?:use|ব্যবহার|দিয়ে|diye)/i.test(t)
  const clientSeo = targets.length > 0 && /\bseo\b|এসইও|audit|অডিট/i.test(t)
  const reportArtifact = clientSeo && /report|রিপোর্ট|file|ফাইল|evidence|প্রমাণ|customer|client|কাস্টমার|ক্লায়েন্ট/i.test(t)
  const remember = /মনে\s*(?:রাখ|রেখ)|remember\s+this|save\s+(?:this\s+)?(?:to\s+)?memory|don't\s+forget/i.test(t)
  return { liveBrowser, clientSeo, reportArtifact, remember, targets }
}

export function buildOwnerRequirementNote(req: OwnerTurnRequirements): string {
  const lines: string[] = []
  if (req.targets.length) lines.push(`Ordered targets: ${req.targets.join(' → ')}`)
  if (req.liveBrowser) {
    lines.push('Live Chrome is REQUIRED: visit and LOOK at at least 5 distinct pages per target; crawler-only completion is forbidden.')
  }
  if (req.clientSeo) lines.push('Each target requires its own crawl, executed result, full report read, and download links before moving on.')
  if (req.reportArtifact) lines.push('A client-ready artifact is REQUIRED; prose alone is not delivery.')
  if (req.remember) lines.push('save_memory is REQUIRED before acknowledging this explicit remember request.')
  if (!lines.length) return ''
  return `[SERVER REQUIREMENT CONTRACT — derived from Boss's exact message; cannot be waived by the model]\n${lines.map((l) => `• ${l}`).join('\n')}`
}
