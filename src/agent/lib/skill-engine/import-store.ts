/**
 * Skill Engine V2 — Prisma adapter for the imported-skill store (Phase B4).
 * Implements the ImportedSkillStore contract from import.ts over `agent_imported_skills`.
 */
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import type { ImportedSkillStore, ImportedSkillRecord } from '@/agent/lib/skill-engine/import'
import type { ImportedSkillStatus } from '@/agent/lib/skill-engine/import-lifecycle'
import type { ImportScanResult } from '@/agent/lib/skill-engine/import-scan'

type Row = {
  id: string
  name: string
  sourceRepo: string
  sourceCommit: string
  contentHash: string
  status: string
  verdict: string
  findings: Prisma.JsonValue | null
  reviewedBy: string | null
  supersedes: string | null
}

function toRecord(row: Row): ImportedSkillRecord {
  return {
    id: row.id,
    name: row.name,
    sourceRepo: row.sourceRepo,
    sourceCommit: row.sourceCommit,
    contentHash: row.contentHash,
    status: row.status as ImportedSkillStatus,
    verdict: row.verdict as ImportScanResult['verdict'],
    findings: (row.findings as unknown as ImportScanResult['findings']) ?? [],
    reviewedBy: row.reviewedBy,
    supersedes: row.supersedes,
  }
}

export const prismaImportedSkillStore: ImportedSkillStore = {
  async upsert(rec) {
    const row = await prisma.agentImportedSkill.upsert({
      where: { name_sourceCommit: { name: rec.name, sourceCommit: rec.sourceCommit } },
      create: {
        id: rec.id,
        name: rec.name,
        sourceRepo: rec.sourceRepo,
        sourceCommit: rec.sourceCommit,
        contentHash: rec.contentHash,
        status: rec.status,
        verdict: rec.verdict,
        findings: rec.findings as unknown as Prisma.InputJsonValue,
        reviewedBy: rec.reviewedBy,
        supersedes: rec.supersedes,
      },
      update: {
        contentHash: rec.contentHash,
        status: rec.status,
        verdict: rec.verdict,
        findings: rec.findings as unknown as Prisma.InputJsonValue,
      },
    })
    return toRecord(row as Row)
  },

  async findById(id) {
    const row = await prisma.agentImportedSkill.findUnique({ where: { id } })
    return row ? toRecord(row as Row) : null
  },

  async findActive(name) {
    const row = await prisma.agentImportedSkill.findFirst({ where: { name, status: 'active' } })
    return row ? toRecord(row as Row) : null
  },

  async update(id, patch) {
    const row = await prisma.agentImportedSkill.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.reviewedBy !== undefined ? { reviewedBy: patch.reviewedBy } : {}),
        ...(patch.supersedes !== undefined ? { supersedes: patch.supersedes } : {}),
      },
    })
    return toRecord(row as Row)
  },
}
