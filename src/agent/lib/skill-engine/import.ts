/**
 * Skill Engine V2 — GitHub import orchestrator (Phase B4).
 *
 * Ties the safety scan (import-scan) to the lifecycle store (import-lifecycle): scan an
 * untrusted, commit-pinned package → record it (quarantined if blocked, else draft) →
 * gate every promotion → keep exactly one `active` version per skill with rollback.
 *
 * The persistence layer is an INTERFACE so the whole flow is unit-testable with an
 * in-memory store; the Prisma adapter (import-store.ts) implements it for production.
 * The live git-clone of the pinned commit into a no-secret/no-network sandbox is a
 * separate owner-gated WORKBENCH job that feeds this orchestrator the fetched files.
 */
import { scanSkillPackageForImport, type ImportCandidate, type ImportScanResult } from '@/agent/lib/skill-engine/import-scan'
import { assertPromotion, initialStatusFor, type ImportedSkillStatus } from '@/agent/lib/skill-engine/import-lifecycle'

export interface ImportedSkillRecord {
  id: string
  name: string
  sourceRepo: string
  sourceCommit: string
  contentHash: string
  status: ImportedSkillStatus
  verdict: ImportScanResult['verdict']
  findings: ImportScanResult['findings']
  reviewedBy: string | null
  supersedes: string | null
}

/** Persistence contract — Prisma implements this; tests use an in-memory version. */
export interface ImportedSkillStore {
  upsert(rec: ImportedSkillRecord): Promise<ImportedSkillRecord>
  findById(id: string): Promise<ImportedSkillRecord | null>
  findActive(name: string): Promise<ImportedSkillRecord | null>
  update(id: string, patch: Partial<ImportedSkillRecord>): Promise<ImportedSkillRecord>
}

export interface IngestInput extends ImportCandidate {
  /** A stable id for this (name, commit) version — caller supplies (no Date/random here). */
  id: string
  name: string
  sourceRepo: string
  sourceCommit: string
}

/** Scan + record a freshly-fetched package. Blocked scans are quarantined, never live. */
export async function ingestImportedSkill(
  store: ImportedSkillStore,
  input: IngestInput,
): Promise<{ record: ImportedSkillRecord; scan: ImportScanResult }> {
  if (!input.sourceCommit) throw new Error('imported skill must pin a source commit')
  const scan = scanSkillPackageForImport(input)
  const record: ImportedSkillRecord = {
    id: input.id,
    name: input.name,
    sourceRepo: input.sourceRepo,
    sourceCommit: input.sourceCommit,
    contentHash: scan.contentHash,
    status: initialStatusFor(scan),
    verdict: scan.verdict,
    findings: scan.findings,
    reviewedBy: null,
    supersedes: null,
  }
  const saved = await store.upsert(record)
  return { record: saved, scan }
}

/**
 * Promote a version one step. Promotion to `active` atomically retires the current
 * active version for that skill and points `supersedes` at it (for rollback). A blocked
 * or illegal transition throws (assertPromotion).
 */
export async function promoteImportedSkill(
  store: ImportedSkillStore,
  id: string,
  to: ImportedSkillStatus,
  reviewedBy: string,
): Promise<ImportedSkillRecord> {
  const rec = await store.findById(id)
  if (!rec) throw new Error(`imported skill ${id} not found`)
  assertPromotion(rec.status, to, rec.verdict)

  let supersedes = rec.supersedes
  if (to === 'active') {
    const currentActive = await store.findActive(rec.name)
    if (currentActive && currentActive.id !== id) {
      await store.update(currentActive.id, { status: 'retired' })
      supersedes = currentActive.id
    }
  }
  return store.update(id, { status: to, reviewedBy, supersedes })
}

/** Retire a version outright. */
export async function retireImportedSkill(store: ImportedSkillStore, id: string): Promise<ImportedSkillRecord> {
  return store.update(id, { status: 'retired' })
}

/**
 * Roll back a skill: retire the current active version and restore the one it superseded
 * back to `active`. No-op-safe when there is no prior version.
 */
export async function rollbackImportedSkill(store: ImportedSkillStore, name: string): Promise<ImportedSkillRecord | null> {
  const active = await store.findActive(name)
  if (!active) return null
  await store.update(active.id, { status: 'retired' })
  if (!active.supersedes) return null
  const prior = await store.findById(active.supersedes)
  if (!prior) return null
  return store.update(prior.id, { status: 'active' })
}
