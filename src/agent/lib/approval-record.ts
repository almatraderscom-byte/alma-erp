/**
 * What a settled approval card says about itself.
 *
 * Owner caught this himself, 2026-07-27: the green record read "আপনি অনুমোদন
 * করেছিলেন — কাজটি সম্পন্ন হয়েছে" for an SEO audit that had never been in front of
 * him. Read-only crawls and queued generations create their row already
 * 'approved' on purpose — no card was ever meant to appear — and the record then
 * put words in his mouth. A record that invents his decisions is worse than no
 * record.
 *
 * The signal needs no new column: the approve route always stamps `resolvedAt`,
 * so a row without one was never his call.
 */
export interface ResolvedRecord {
  icon: string
  label: string
  tone: string
  text: string
}

/** He decided it. */
export const RESOLVED_RECORD: Record<string, ResolvedRecord> = {
  approved: { icon: '✅', label: 'অনুমোদিত', tone: 'border tone-green', text: 'আপনি অনুমোদন করেছিলেন' },
  executed: { icon: '✅', label: 'অনুমোদিত ও সম্পন্ন', tone: 'border tone-green', text: 'আপনি অনুমোদন করেছিলেন — কাজটি সম্পন্ন হয়েছে' },
  rejected: { icon: '❌', label: 'বাতিল', tone: 'border tone-red', text: 'আপনি বাতিল করেছিলেন' },
  expired: { icon: '⏱️', label: 'সময় শেষ', tone: 'border tone-slate', text: 'সময় শেষ হয়ে গিয়েছিল — সিদ্ধান্ত নেওয়া হয়নি' },
  failed: { icon: '⚠️', label: 'ব্যর্থ', tone: 'border tone-amber', text: 'অনুমোদন করেছিলেন, কিন্তু কাজটি ব্যর্থ হয়েছে' },
}

/** It ran under standing authority and never reached him. */
export const AUTO_RUN_RECORD: Record<string, ResolvedRecord> = {
  approved: { icon: '⚙️', label: 'স্বয়ংক্রিয়', tone: 'border tone-slate', text: 'অনুমোদন লাগেনি — নিজে থেকেই চলেছে' },
  executed: { icon: '⚙️', label: 'স্বয়ংক্রিয়ভাবে সম্পন্ন', tone: 'border tone-slate', text: 'অনুমোদন লাগেনি — নিজে থেকেই হয়ে গেছে' },
  failed: { icon: '⚠️', label: 'ব্যর্থ', tone: 'border tone-amber', text: 'নিজে থেকে চলেছিল, কিন্তু কাজটি ব্যর্থ হয়েছে' },
}

/**
 * `ownerDecided === false` means the row carries no `resolvedAt` — he never saw
 * it. `undefined` means the caller does not know yet, and keeps the old wording
 * so nothing regresses silently.
 */
export function resolvedRecordFor(
  status: string | undefined,
  ownerDecided: boolean | undefined,
): ResolvedRecord | undefined {
  if (!status) return undefined
  if (ownerDecided === false) return AUTO_RUN_RECORD[status] ?? RESOLVED_RECORD[status]
  return RESOLVED_RECORD[status]
}
