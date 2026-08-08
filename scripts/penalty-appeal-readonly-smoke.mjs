#!/usr/bin/env node
/**
 * Read-only production smoke for penalty appeals, staff photos, and wallet history.
 * This script deliberately performs GET requests only.
 */
import { loadRegressionEnvFiles } from './regression-env.mjs'
import { resolveRegressionCookie } from './regression-resolve-auth.mjs'

loadRegressionEnvFiles()

const BASE = (process.env.REGRESSION_BASE_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
const BUSINESS = process.env.REGRESSION_BUSINESS_ID || 'ALMA_LIFESTYLE'
let cookie = process.env.REGRESSION_COOKIE || ''
const failures = []
const warnings = []

function pass(name, detail = '') {
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name, detail) {
  failures.push(`${name}: ${detail}`)
  console.error(`[FAIL] ${name} — ${detail}`)
}

function warn(name, detail) {
  warnings.push(`${name}: ${detail}`)
  console.warn(`[WARN] ${name} — ${detail}`)
}

function unwrap(body) {
  return body?.ok === true && body.data ? body.data : body
}

async function get(path, accept = 'application/json') {
  const response = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: { Accept: accept, Cookie: cookie },
    cache: 'no-store',
    redirect: 'follow',
  })
  return response
}

async function json(path) {
  const response = await get(path)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${response.status})`)
  }
  if (!response.ok || body?.ok === false) {
    const message = body?.error?.message || body?.error || body?.message || `HTTP ${response.status}`
    throw new Error(`${path}: ${message}`)
  }
  return unwrap(body)
}

async function main() {
  if (!cookie) {
    const resolved = await resolveRegressionCookie(BASE)
    cookie = resolved.cookie
    console.log(`[auth] Session resolved via ${resolved.source}; secret not logged`)
  }
  if (!cookie) throw new Error('Regression authentication is required')

  const attendance = await json(`/api/attendance?business_id=${encodeURIComponent(BUSINESS)}`)
  const pending = Array.isArray(attendance?.pendingWaivers) ? attendance.pendingWaivers : []
  const decisions = Array.isArray(attendance?.recentWaiverDecisions)
    ? attendance.recentWaiverDecisions
    : []
  const records = Array.isArray(attendance?.records) ? attendance.records : []
  const absentees = Array.isArray(attendance?.absentEmployees) ? attendance.absentEmployees : []

  pass('attendance_contract', `records=${records.length}, pending=${pending.length}, decisions=${decisions.length}`)

  const appealRows = [...pending, ...decisions]
  const invalidAppeals = appealRows.filter((row) =>
    !row?.id || !row?.requesterUserId
    || !(Number(row?.originalPenaltyAmount) > 0)
    || Number(row?.requestedReductionAmount || 0) > Number(row?.originalPenaltyAmount),
  )
  if (invalidAppeals.length) {
    const kinds = invalidAppeals.map((row) => [
      String(row?.id || 'no-id').slice(0, 8),
      row?.status || 'UNKNOWN',
      row?.requestType || 'UNKNOWN_TYPE',
      row?.penaltyKind || 'UNKNOWN_KIND',
      row?.penaltyLedgerEntryId ? 'linked' : 'unlinked',
      Number(row?.originalPenaltyAmount || 0) > 0 ? 'amount-ok' : 'amount-invalid',
      Number(row?.requestedReductionAmount || 0) <= Number(row?.originalPenaltyAmount || 0) ? 'request-ok' : 'request-over',
    ].join('/'))
    fail('appeal_linkage', `${invalidAppeals.length} rows: ${kinds.join(', ')}`)
  }
  else pass('appeal_amounts', `${appealRows.length} rows preserve requester identity and amount bounds`)

  const unresolvedLegacy = appealRows.filter((row) => !row?.penaltyLedgerEntryId)
  if (unresolvedLegacy.length) {
    warn('legacy_fine_identity', `${unresolvedLegacy.length} historical appeal(s) need exact-ledger verification; reviewer safety is checked below`)
  } else {
    pass('appeal_linkage', `${appealRows.length} sampled appeals have exact fine links`)
  }

  const activeLedgerIds = pending.map((row) => row.penaltyLedgerEntryId).filter(Boolean)
  if (new Set(activeLedgerIds).size !== activeLedgerIds.length) {
    fail('once_only_pending', 'duplicate pending appeals target the same fine')
  } else {
    pass('once_only_pending', `${activeLedgerIds.length} active fine IDs are unique`)
  }

  const badDecision = decisions.filter((row) => {
    const resolved = ['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'CANCELLED'].includes(row?.status)
    const hasAudit = row?.status === 'CANCELLED' || (row?.reviewedAt && row?.reviewerName)
    const refundOk = !['APPROVED', 'PARTIALLY_APPROVED'].includes(row?.status) || row?.refundReconciled === true
    return !resolved || !hasAudit || !refundOk
  })
  if (badDecision.length) {
    const kinds = badDecision.map((row) => [
      row?.status || 'UNKNOWN',
      row?.reviewedAt ? 'reviewed-at' : 'no-reviewed-at',
      row?.reviewerName ? 'reviewer' : 'no-reviewer',
      !['APPROVED', 'PARTIALLY_APPROVED'].includes(row?.status) || row?.refundReconciled === true ? 'refund-ok' : 'refund-broken',
    ].join('/'))
    fail('decision_audit', `${badDecision.length} rows: ${kinds.join(', ')}`)
  }
  else pass('decision_audit', `${decisions.length} recent decisions have professional audit state`)

  const legacyMissingReasons = decisions.filter((row) =>
    row?.status === 'REJECTED' && String(row?.adminNote || '').trim().length < 5,
  )
  if (legacyMissingReasons.length) {
    warn('legacy_rejection_reason', `${legacyMissingReasons.length} pre-policy rejection(s) have no stored reason; UI labels them explicitly`)
  } else {
    pass('rejection_reasons', 'all sampled rejections include a stored reason')
  }

  const photoCandidates = [...pending, ...decisions, ...records, ...absentees]
    .filter((row) => row?.requesterProfileImageUrl || row?.profileImageUrl)
  const photoUserId = photoCandidates[0]?.requesterUserId || photoCandidates[0]?.userId || photoCandidates[0]?.id
  if (!photoUserId) {
    warn('profile_image', 'no attendance row currently has a configured staff photo to fetch')
  } else {
    const response = await get(`/api/users/${encodeURIComponent(photoUserId)}/profile-image?size=thumb`, 'image/*')
    const contentType = response.headers.get('content-type') || ''
    const bytes = (await response.arrayBuffer()).byteLength
    if (!response.ok || !contentType.startsWith('image/') || bytes === 0) {
      fail('profile_image', `HTTP ${response.status}, type=${contentType || 'missing'}, bytes=${bytes}`)
    } else {
      pass('profile_image', `authenticated image response ${contentType}, ${bytes} bytes`)
    }
  }

  const approvals = await json('/api/approvals?status=PENDING&limit=100')
  const approvalRows = Array.isArray(approvals?.approvals) ? approvals.approvals : []
  const penaltyApprovals = approvalRows.filter((row) => row?.module === 'PENALTY_APPEAL' || row?.type === 'PENALTY_APPEAL')
  const brokenContext = penaltyApprovals.filter((row) => {
    const context = row?.penaltyAppeal
    return !context?.fineDate || !context?.fineKind
      || !(Number(context?.originalPenaltyAmount) > 0)
      || Number(context?.requestedReductionAmount || 0) > Number(context?.originalPenaltyAmount)
  })
  if (brokenContext.length) fail('approval_context', `${brokenContext.length} penalty approvals lack exact review context`)
  else pass('approval_context', `${penaltyApprovals.length} pending penalty reviews expose exact date/kind/amount context`)

  const unresolvedReviews = penaltyApprovals.filter((row) => row?.penaltyAppeal?.fineIdentityResolved !== true)
  const unsafeUnresolved = unresolvedReviews.filter((row) =>
    row?.executable !== false || row?.penaltyAppeal?.fineKind !== 'UNKNOWN',
  )
  if (unsafeUnresolved.length) {
    fail('ambiguous_review_safety', `${unsafeUnresolved.length} ambiguous appeal(s) can still be approved or are mislabeled`)
  } else if (unresolvedReviews.length) {
    warn('ambiguous_review_safety', `${unresolvedReviews.length} ambiguous historical appeal(s) are explicitly UNKNOWN and approval-blocked`)
  } else {
    pass('ambiguous_review_safety', 'every pending review has a deterministic fine identity')
  }

  const employeeId = appealRows[0]?.employeeId || records[0]?.employeeId
  if (!employeeId) {
    warn('wallet_history', 'no attendance employee is available for a read-only wallet sample')
  } else {
    const wallet = await json(`/api/payroll/wallet/${encodeURIComponent(employeeId)}?business_id=${encodeURIComponent(BUSINESS)}`)
    if (!Array.isArray(wallet?.entries) || !wallet?.summary || !wallet?.fineSummaries) {
      fail('wallet_history', 'wallet statement is missing entries, summary, or fine summaries')
    } else {
      const penaltyEntries = wallet.entries.filter((entry) => entry?.type === 'PENALTY')
      pass('wallet_history', `entries=${wallet.entries.length}, penalties=${penaltyEntries.length}, running statement available`)
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} read-only production smoke check(s) failed.`)
    process.exit(1)
  }
  console.log(`\nRead-only penalty/profile/wallet smoke passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`)
}

main().catch((error) => {
  console.error(`[FAIL] smoke_setup — ${error?.message || String(error)}`)
  process.exit(1)
})
