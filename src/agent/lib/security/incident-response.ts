/**
 * Phase 55 — security incident response: kill switch, quarantine, immutable
 * audit, owner alert, forensic trace.
 *
 * When a critical hostile signal fires (injection driving an effect, secret
 * egress attempt, compromised-page tool call), triggerSecurityIncident():
 *   1. QUARANTINES the risky autonomous surfaces (KV flags checked by the
 *      browser agent / heartbeat paths before every run)
 *   2. writes an immutable audit record (AgentAuditLog — append-only usage)
 *   3. alerts the owner (tier-2 push, best-effort)
 *   4. returns the incident record for the caller's forensic trace
 *
 * Fail-closed by contract: if the quarantine WRITE fails, callers must treat
 * the system as quarantined (isQuarantined returns true on read failure for
 * effect surfaces).
 */
import { prisma } from '@/lib/prisma'
import { scrubForLog } from './secret-dlp'

export const SECURITY_QUARANTINE_KV_KEY = 'security_quarantine'
export const INCIDENT_AUDIT_ACTION = 'security_incident'

export type IncidentKind =
  | 'prompt_injection_effect' // untrusted content tried to drive an effect
  | 'secret_egress' // a secret was about to leave
  | 'envelope_violation' // a tool call outside its signed envelope
  | 'permission_escalation'
  | 'poisoned_memory'
  | 'confused_deputy'
  | 'manual' // owner/operator triggered

export interface IncidentRecord {
  id: string
  kind: IncidentKind
  source: string
  evidence: string
  quarantined: boolean
  at: string
}

export interface QuarantineState {
  active: boolean
  reason?: string
  incidentId?: string
  at?: string
}

/**
 * Read quarantine state. `failClosed` (default true) — a read FAILURE reports
 * quarantine ACTIVE, because effect surfaces must not run when the security
 * subsystem is unreachable (constitution rule 8).
 */
export async function getQuarantineState(failClosed = true): Promise<QuarantineState> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: SECURITY_QUARANTINE_KV_KEY }, select: { value: true } })
    if (!row?.value) return { active: false }
    const parsed = JSON.parse(row.value) as QuarantineState
    return { active: parsed.active === true, reason: parsed.reason, incidentId: parsed.incidentId, at: parsed.at }
  } catch {
    return failClosed
      ? { active: true, reason: 'security store unreachable — fail closed' }
      : { active: false }
  }
}

export async function isQuarantined(): Promise<boolean> {
  return (await getQuarantineState(true)).active
}

/** Owner lifts the quarantine after review (Control Center / chat command). */
export async function clearQuarantine(byNote: string): Promise<boolean> {
  try {
    await prisma.agentKvSetting.upsert({
      where: { key: SECURITY_QUARANTINE_KV_KEY },
      create: { key: SECURITY_QUARANTINE_KV_KEY, value: JSON.stringify({ active: false }) },
      update: { value: JSON.stringify({ active: false }) },
    })
    await prisma.agentAuditLog.create({
      data: { actionType: INCIDENT_AUDIT_ACTION, actor: 'owner', payload: { cleared: true, note: byNote.slice(0, 300) } },
    })
    return true
  } catch {
    return false
  }
}

export interface TriggerIncidentOptions {
  kind: IncidentKind
  /** Where it happened (url / tool / surface). */
  source: string
  /** What was seen — DLP-scrubbed before persisting. */
  evidence: string
  /** Also flip the quarantine flag (default true for critical kinds). */
  quarantine?: boolean
  /** Skip the owner push (tests). */
  silent?: boolean
}

/**
 * Record + respond to a security incident. Never throws — but reports honestly
 * whether each protective step took hold.
 */
export async function triggerSecurityIncident(opts: TriggerIncidentOptions): Promise<IncidentRecord & { auditOk: boolean }> {
  const at = new Date().toISOString()
  const evidence = scrubForLog(String(opts.evidence ?? '')).slice(0, 2000)
  const record: IncidentRecord & { auditOk: boolean } = {
    id: `inc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: opts.kind,
    source: String(opts.source ?? '').slice(0, 300),
    evidence,
    quarantined: false,
    at,
    auditOk: false,
  }

  const wantQuarantine = opts.quarantine !== false

  // 1. Quarantine flag — the kill switch risky surfaces poll before running.
  if (wantQuarantine) {
    try {
      await prisma.agentKvSetting.upsert({
        where: { key: SECURITY_QUARANTINE_KV_KEY },
        create: { key: SECURITY_QUARANTINE_KV_KEY, value: JSON.stringify({ active: true, reason: `${opts.kind}: ${record.source}`, incidentId: record.id, at }) },
        update: { value: JSON.stringify({ active: true, reason: `${opts.kind}: ${record.source}`, incidentId: record.id, at }) },
      })
      record.quarantined = true
    } catch (err) {
      console.error('[incident-response] quarantine write FAILED (callers must fail closed):', err instanceof Error ? err.message : err)
    }
  }

  // 2. Immutable audit row (append-only usage of AgentAuditLog).
  try {
    await prisma.agentAuditLog.create({
      data: {
        actionType: INCIDENT_AUDIT_ACTION,
        resourceId: record.id,
        actor: 'security_kernel',
        payload: { kind: opts.kind, source: record.source, evidence, quarantined: record.quarantined, at },
      },
    })
    record.auditOk = true
  } catch (err) {
    console.error('[incident-response] audit write failed:', err instanceof Error ? err.message : err)
  }

  // 3. Owner alert — best-effort, never blocks the response.
  if (!opts.silent) {
    try {
      const { notifyOwner } = await import('@/agent/lib/notify-owner')
      await notifyOwner({
        tier: 2,
        title: '🛑 নিরাপত্তা সতর্কতা',
        message:
          `Boss, একটা নিরাপত্তা ঘটনা ধরেছি (${opts.kind}) — উৎস: ${record.source}।\n` +
          (record.quarantined ? 'স্বয়ংক্রিয় ব্রাউজার/ঝুঁকির কাজ আপাতত বন্ধ (quarantine) করে দিয়েছি।' : 'Quarantine দেওয়া যায়নি — ম্যানুয়ালি দেখুন।') +
          '\nবিস্তারিত ইনসিডেন্ট রেকর্ডে আছে।',
        category: 'urgent',
      }).catch(() => {})
    } catch {
      /* alert path optional */
    }
  }

  return record
}

/** Forensic trace for one incident id (from the audit log). */
export async function getIncidentTrace(incidentId: string): Promise<unknown[]> {
  try {
    const rows = await prisma.agentAuditLog.findMany({
      where: { actionType: INCIDENT_AUDIT_ACTION, resourceId: incidentId },
      orderBy: { createdAt: 'asc' },
    })
    return rows
  } catch {
    return []
  }
}
