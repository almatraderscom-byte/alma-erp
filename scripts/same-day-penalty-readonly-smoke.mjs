#!/usr/bin/env node
/**
 * Read-only production audit for attendance fine identity.
 *
 * Proves that late check-in, early check-out, and no-checkout penalties remain
 * separate from ledger row through appeal and refund presentation. GET only.
 */
import { loadRegressionEnvFiles } from './regression-env.mjs'
import { resolveRegressionCookie } from './regression-resolve-auth.mjs'

loadRegressionEnvFiles()

const BASE = (process.env.REGRESSION_BASE_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
const BUSINESS = process.env.REGRESSION_BUSINESS_ID || 'ALMA_LIFESTYLE'
const ATTENDANCE_FINE_SOURCES = new Set([
  'attendance_late_penalty',
  'attendance_early_leave_penalty',
  'attendance_no_checkout_fine',
])
let cookie = process.env.REGRESSION_COOKIE || ''
const failures = []

function pass(name, detail) {
  console.log(`[PASS] ${name} — ${detail}`)
}

function fail(name, detail) {
  failures.push(`${name}: ${detail}`)
  console.error(`[FAIL] ${name} — ${detail}`)
}

function unwrap(body) {
  return body?.ok === true && body.data ? body.data : body
}

async function json(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json', Cookie: cookie },
    cache: 'no-store',
    redirect: 'follow',
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${response.status})`)
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error?.message || body?.error || body?.message || `${path}: HTTP ${response.status}`)
  }
  return unwrap(body)
}

function dayKey(entry) {
  return new Date(entry.date).toISOString().slice(0, 10)
}

async function main() {
  if (!cookie) {
    const resolved = await resolveRegressionCookie(BASE)
    cookie = resolved.cookie
    console.log(`[auth] Session resolved via ${resolved.source}; secret not logged`)
  }
  if (!cookie) throw new Error('Regression authentication is required')

  const report = await json(`/api/payroll/wallet/reports?business_id=${encodeURIComponent(BUSINESS)}`)
  const waiverReport = await json(`/api/attendance/waivers?business_id=${encodeURIComponent(BUSINESS)}`)
  const waiverById = new Map(
    (Array.isArray(waiverReport?.waivers) ? waiverReport.waivers : [])
      .map((waiver) => [String(waiver.id), waiver]),
  )
  const wallets = Array.isArray(report?.wallets) ? report.wallets : []
  const employeesWithFines = wallets
    .filter((wallet) => Array.isArray(wallet.transactions)
      && wallet.transactions.some((entry) => entry?.type === 'PENALTY' && ATTENDANCE_FINE_SOURCES.has(entry?.source)))
    .map((wallet) => wallet.employeeId)

  pass('wallet_report', `wallets=${wallets.length}, attendance-fine employees=${employeesWithFines.length}`)

  const seenLedgerIds = new Set()
  const waiverTargets = new Map()
  const refundTargets = new Map()
  let fines = 0
  let sameDayMultiFineGroups = 0
  let appealedFines = 0

  for (const employeeId of employeesWithFines) {
    const wallet = await json(`/api/payroll/wallet/${encodeURIComponent(employeeId)}?business_id=${encodeURIComponent(BUSINESS)}`)
    const entries = Array.isArray(wallet?.entries) ? wallet.entries : []
    const entryById = new Map(entries.map((entry) => [String(entry.id), entry]))
    const attendanceFines = entries.filter((entry) =>
      entry?.type === 'PENALTY' && ATTENDANCE_FINE_SOURCES.has(entry?.source),
    )
    const groups = new Map()

    for (const fine of attendanceFines) {
      fines += 1
      const fineId = String(fine.id || '')
      if (!fineId) {
        fail('ledger_identity', `${employeeId} has an attendance fine without an ID`)
        continue
      }
      if (seenLedgerIds.has(fineId)) fail('ledger_identity', `duplicate fine ID ${fineId}`)
      seenLedgerIds.add(fineId)

      const key = `${employeeId}:${dayKey(fine)}`
      groups.set(key, [...(groups.get(key) || []), fine])
      const appeal = fine.appeal
      if (!appeal) {
        fail('appeal_contract', `${fineId} has no per-fine appeal state`)
        continue
      }

      if (appeal.waiverId) {
        appealedFines += 1
        const prior = waiverTargets.get(appeal.waiverId)
        if (prior && prior !== fineId) {
          fail('one_appeal_one_fine', `waiver ${appeal.waiverId} appears on ${prior} and ${fineId}`)
        }
        waiverTargets.set(appeal.waiverId, fineId)
      }

      if (appeal.refundEntryId) {
        const prior = refundTargets.get(appeal.refundEntryId)
        if (prior && prior !== fineId) {
          fail('one_refund_one_fine', `refund ${appeal.refundEntryId} appears on ${prior} and ${fineId}`)
        }
        refundTargets.set(appeal.refundEntryId, fineId)
        const refund = entryById.get(String(appeal.refundEntryId))
        if (!refund || refund.type !== 'ADJUSTMENT' || refund.relatedEntryId !== fineId) {
          fail('refund_linkage', `${fineId} refund does not point back to the exact fine`)
        }
      }

      if (appeal.refundedAmount > Math.abs(Number(fine.amount || 0))) {
        const waiver = appeal.waiverId ? waiverById.get(String(appeal.waiverId)) : null
        const sameDayFines = attendanceFines
          .filter((candidate) => dayKey(candidate) === dayKey(fine))
          .map((candidate) => `${candidate.source}:${Math.abs(Number(candidate.amount || 0))}:${candidate.id}:ref=${candidate.sourceRef || 'none'}:record=${candidate.appeal?.attendanceRecordId || 'none'}:appeal=${candidate.appeal?.status || 'none'}:${candidate.appeal?.waiverId || 'none'}`)
          .join(', ')
        fail(
          'refund_amount',
          `${fineId} (${dayKey(fine)}, ${fine.source}, fine=${Math.abs(Number(fine.amount || 0))}, original=${waiver?.originalPenaltyAmount ?? 'unknown'}, requested=${appeal.requestedReductionAmount ?? 'none'}, approved=${appeal.approvedReductionAmount ?? 'none'}, refund=${appeal.refundedAmount}, waiver=${appeal.waiverId || 'none'}, refundEntry=${appeal.refundEntryId || 'none'}, dayFines=[${sameDayFines}]) refund exceeds its own fine amount`,
        )
      }
      if (['APPROVED', 'PARTIALLY_APPROVED'].includes(appeal.status) && appeal.refundReconciled !== true) {
        fail('refund_reconciliation', `${fineId} approved appeal is not reconciled`)
      }
      if (appeal.waiverId && appeal.appealable === true) {
        fail('once_only_policy', `${fineId} remains appealable after an appeal exists`)
      }
    }

    for (const [key, rows] of groups) {
      if (rows.length < 2) continue
      sameDayMultiFineGroups += 1
      const rowIds = rows.map((row) => String(row.id))
      const distinctKinds = new Set(rows.map((row) => row.source))
      if (new Set(rowIds).size !== rows.length || distinctKinds.size !== rows.length) {
        fail('same_day_independence', `${key} does not have distinct fine rows/kinds`)
      }
    }
  }

  if (!failures.length) {
    pass(
      'same_day_independence',
      `${sameDayMultiFineGroups} multi-fine day(s), ${fines} independent fine rows, ${appealedFines} appealed rows`,
    )
    pass('appeal_refund_identity', `${waiverTargets.size} appeals and ${refundTargets.size} refunds map one-to-one`)
  }

  if (failures.length) {
    console.error(`\n${failures.length} same-day penalty audit check(s) failed.`)
    process.exit(1)
  }
  console.log('\nRead-only same-day penalty identity audit passed.')
}

main().catch((error) => {
  console.error(`[FAIL] smoke_setup — ${error?.message || String(error)}`)
  process.exit(1)
})
