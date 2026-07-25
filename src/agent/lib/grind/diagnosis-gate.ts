/**
 * S3 — root cause is forced STRUCTURALLY, not by asking nicely.
 *
 * Two mechanisms, both deterministic:
 *  1. every fix step depends on its family's diagnose step (step-builder), so
 *     the dependency machinery physically orders them;
 *  2. this gate, which the driver consults BEFORE dispatching a fix step: if the
 *     family's findings do not carry a real root cause with a concrete reference,
 *     the fix is not allowed to run.
 *
 * Fail-safe direction matters: when the gate cannot tell, it says NOT READY. The
 * cost of a false "not ready" is one more diagnosis round; the cost of a false
 * "ready" is a blind fix that creates a new problem — which is precisely what
 * Boss said must never happen.
 */
import { listFindings, type FindingRow } from '@/agent/lib/grind/finding-set'
import { getStepMeta } from '@/agent/lib/grind/campaign'

/** A root cause shorter than this is a label, not an explanation. */
export const MIN_ROOT_CAUSE_CHARS = 40

/** file:line, a URL, or a table/column reference — something a human can open. */
const CONCRETE_REF = /(^|[\s(])([\w./-]+\.\w{1,5}:\d+)|https?:\/\/\S+|\b[a-z_]+\.[a-z_]+\b/i

export interface GateVerdict {
  ready: boolean
  /** Fingerprints that are missing a usable root cause. */
  missing: string[]
  reason: string
}

/** Does one finding carry a diagnosis a fix can actually be built on? */
export function hasUsableRootCause(f: Pick<FindingRow, 'rootCause' | 'rootCauseRef'>): boolean {
  const cause = (f.rootCause ?? '').trim()
  const ref = (f.rootCauseRef ?? '').trim()
  if (cause.length < MIN_ROOT_CAUSE_CHARS) return false
  if (!ref) return false
  return CONCRETE_REF.test(ref)
}

/** Pure — the same check the tests pin, with no DB in the way. */
export function gateFindings(findings: FindingRow[]): GateVerdict {
  const missing = findings.filter((f) => !hasUsableRootCause(f)).map((f) => f.fingerprint)
  if (findings.length === 0) {
    return { ready: false, missing: [], reason: 'এই ব্যাচে কোনো finding নেই — কী ঠিক করব জানা নেই।' }
  }
  if (missing.length > 0) {
    return {
      ready: false,
      missing,
      reason:
        `${missing.length}/${findings.length}টা সমস্যার আসল কারণ এখনো লেখা হয়নি ` +
        `(কমপক্ষে ${MIN_ROOT_CAUSE_CHARS} অক্ষরের ব্যাখ্যা + একটা সুনির্দিষ্ট রেফারেন্স — file:line বা URL)। ` +
        `কারণ না জেনে ঠিক করতে দেব না।`,
    }
  }
  return { ready: true, missing: [], reason: 'সব সমস্যার কারণ ও প্রমাণ আছে।' }
}

/**
 * Driver pre-flight for ONE step. Non-grind steps and non-fix steps are always
 * allowed — this gate only guards fixes.
 */
export async function checkStepDiagnosisGate(stepId: string): Promise<GateVerdict> {
  const meta = await getStepMeta(stepId)
  if (!meta || meta.kind !== 'fix') return { ready: true, missing: [], reason: 'gate not applicable' }

  const all = await listFindings(meta.setId)
  const batch = all.filter((f) => meta.fingerprints.includes(f.fingerprint))
  return gateFindings(batch)
}
