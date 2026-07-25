#!/usr/bin/env node
/**
 * Read-only lifecycle migration comparator. It never imports Prisma, opens a
 * network connection, or writes a database. Pass fixture JSON with sourceRows,
 * targetRows and optional expectedBackfill to obtain a machine-readable report.
 */
import { readFile } from 'node:fs/promises'

function countBy(rows, key) {
  return rows.reduce((counts, row) => {
    const value = String(row?.[key] ?? 'missing')
    counts[value] = (counts[value] ?? 0) + 1
    return counts
  }, {})
}

function ids(rows) {
  return new Set(rows.map((row) => String(row?.id ?? '')).filter(Boolean))
}

const ROADMAP_FIELDS = [
  ['ownerId', ['ownerId', 'owner_id']],
  ['brandProfileId', ['brandProfileId', 'brand_profile_id']],
  ['projectId', ['projectId', 'project_id']],
  ['productId', ['productId', 'product_id']],
  ['versionId', ['versionId', 'assetVersionId', 'asset_version_id']],
  ['costUsd', ['costUsd', 'cost_usd']],
  ['qcState', ['qcState', 'qc_state']],
  ['reviewState', ['reviewState', 'review_state']],
  ['publishState', ['publishState', 'publish_state']],
]

function valueFor(row, aliases) {
  for (const key of aliases) {
    if (Object.hasOwn(row ?? {}, key)) return row[key] ?? null
  }
  return null
}

function canonical(value) {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'non_finite'
  return String(value)
}

function reconcileRoadmapFields(sourceRows, targetRows) {
  const targets = new Map(targetRows.map((row) => [String(row?.id ?? ''), row]))
  const mismatches = Object.fromEntries(ROADMAP_FIELDS.map(([field]) => [field, []]))
  const counts = Object.fromEntries(ROADMAP_FIELDS.map(([field]) => [field, {
    sourceDefined: 0, targetDefined: 0, mismatched: 0,
  }]))
  for (const source of sourceRows) {
    const id = String(source?.id ?? '')
    const target = targets.get(id)
    if (!target) continue
    for (const [field, aliases] of ROADMAP_FIELDS) {
      const sourceValue = canonical(valueFor(source, aliases))
      const targetValue = canonical(valueFor(target, aliases))
      if (sourceValue !== null) counts[field].sourceDefined += 1
      if (targetValue !== null) counts[field].targetDefined += 1
      if (sourceValue !== targetValue) {
        mismatches[field].push(id)
        counts[field].mismatched += 1
      }
    }
  }
  return { counts, mismatches, mismatchCount: Object.values(mismatches).reduce((sum, ids) => sum + ids.length, 0) }
}

const path = process.argv[2]
if (!path || path.startsWith('-')) {
  console.error('Usage: node scripts/creative-studio-lifecycle-migration-dry-run.mjs <fixture.json>')
  process.exitCode = 2
} else {
  let input
  try {
    input = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: 'invalid_fixture', detail: error instanceof Error ? error.message : String(error) }))
    process.exitCode = 2
    process.exit()
  }
  const sourceRows = Array.isArray(input.sourceRows) ? input.sourceRows : []
  const targetRows = Array.isArray(input.targetRows) ? input.targetRows : []
  const sourceIds = ids(sourceRows)
  const targetIds = ids(targetRows)
  const missingTargetIds = [...sourceIds].filter((id) => !targetIds.has(id)).sort()
  const unexpectedTargetIds = [...targetIds].filter((id) => !sourceIds.has(id)).sort()
  const expectedBackfill = Number.isInteger(input.expectedBackfill) ? input.expectedBackfill : missingTargetIds.length
  const reconciliation = reconcileRoadmapFields(sourceRows, targetRows)
  const report = {
    ok: missingTargetIds.length === expectedBackfill
      && unexpectedTargetIds.length === 0
      && reconciliation.mismatchCount === 0,
    mode: 'dry_run',
    productionMutation: false,
    networkAccess: false,
    sourceCount: sourceRows.length,
    targetCount: targetRows.length,
    expectedBackfill,
    missingTargetIds,
    unexpectedTargetIds,
    sourceByStatus: countBy(sourceRows, 'status'),
    targetByStatus: countBy(targetRows, 'status'),
    roadmapReconciliation: reconciliation,
    legacyFallbackRequired: input.legacyFallbackEnabled !== false,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}
