/**
 * Phase 1 Sheets mirror for the payroll salary-advance flow.
 *
 * Before this module, `processSalaryAdvance` and the legacy `/api/advances`
 * PATCH route awaited `serverPost('hr_payroll_add', …)` BEFORE updating the
 * Postgres rows. That made Google Sheets the (de-facto) source of truth — a
 * GAS timeout left Postgres `PENDING` while a partial Sheets row may already
 * have been written, and any subsequent retry could double-spend wages.
 *
 * The Phase 1 contract:
 *   - Postgres write happens first and is the only authoritative state.
 *   - Sheets push happens AFTER commit, best-effort, with a hard timeout.
 *   - A GAS failure NEVER rolls back the Postgres transaction.
 *   - A GAS failure DOES emit a critical Sentry/Logtail event so operators
 *     can re-push from the payroll admin tools (existing serverPost retry).
 *
 * Phase 2 will replace this module with a native Postgres payroll ledger
 * that no longer requires Sheets at all.
 */
import { serverPost } from '@/lib/server-api'
import { logEvent } from '@/lib/logger'
import { captureStructuredEvent } from '@/lib/sentry/capture'

const SHEETS_MIRROR_TIMEOUT_MS = 15_000

export type SalaryAdvanceMirrorInput = {
  advanceId: string
  approvalId: string
  businessId: string
  empId: string
  amount: number
  reason: string
  requestedBy: string
  approvedBy: string
  note?: string
  actorPayload?: Record<string, unknown>
}

export type SalaryAdvanceMirrorResult =
  | { ok: true; mirrored: true; gas: unknown; latencyMs: number }
  | { ok: false; mirrored: false; error: string; latencyMs: number }

/**
 * Push an APPROVED salary-advance row to the legacy Google Sheets payroll
 * book as an async mirror. Always returns; never throws.
 *
 * Must only be called AFTER the Postgres update has committed.
 */
export async function mirrorSalaryAdvanceToSheets(
  input: SalaryAdvanceMirrorInput,
): Promise<SalaryAdvanceMirrorResult> {
  const started = Date.now()
  const meta = {
    advanceId: input.advanceId,
    approvalId: input.approvalId,
    businessId: input.businessId,
    empId: input.empId,
    amount: input.amount,
  }
  const payload = {
    emp_id: input.empId,
    business_id: input.businessId,
    tx_type: 'advance',
    amount: input.amount,
    advance_reason: input.reason,
    requested_by: input.requestedBy,
    approved_by: input.approvedBy,
    note: (input.note || '').slice(0, 400),
    ...(input.actorPayload || {}),
  }

  try {
    const gas = await Promise.race([
      serverPost('hr_payroll_add', payload),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`hr_payroll_add_timeout_${SHEETS_MIRROR_TIMEOUT_MS}ms`)),
          SHEETS_MIRROR_TIMEOUT_MS,
        ),
      ),
    ])
    const latencyMs = Date.now() - started
    logEvent('info', 'payroll.gas_sheets_push.success', { ...meta, latencyMs })
    return { ok: true, mirrored: true, gas, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    const message = (err as Error)?.message || String(err)
    logEvent('error', 'payroll.gas_sheets_push.failed', { ...meta, latencyMs, message })
    void captureStructuredEvent('error', 'payroll.gas_sheets_push.failed', {
      ...meta,
      latencyMs,
      message,
      hint: 'Postgres salary advance is APPROVED; re-push to Sheets via admin payroll tools.',
    })
    return { ok: false, mirrored: false, error: message, latencyMs }
  }
}
