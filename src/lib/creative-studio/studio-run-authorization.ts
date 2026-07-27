import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'crypto'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'
import { normalizeStudioRunCap } from '@/lib/creative-studio/studio-policy'
import { roundMoney } from '@/lib/money'

export const STUDIO_RUN_ESTIMATE_TTL_MS = 5 * 60_000
export const STUDIO_RUN_EXECUTION_TTL_MS = 72 * 60 * 60_000
export const STUDIO_RUN_USD_TO_BDT = 125
/**
 * One-time worker migration boundary. Pending paid image/video rows created
 * before this instant predate signed Studio receipts and may finish through
 * the server-verified compatibility path. It is deliberately immutable:
 * moving it forward would silently authorize newly-created unsigned work.
 */
export const STUDIO_UNSIGNED_PAID_JOB_CUTOFF_ISO = '2026-07-26T00:00:00.000Z'
const studioUnsignedPaidJobCutoffMs = Date.parse(STUDIO_UNSIGNED_PAID_JOB_CUTOFF_ISO)
if (!Number.isFinite(studioUnsignedPaidJobCutoffMs)) {
  throw new Error('invalid_studio_unsigned_paid_job_cutoff')
}
export const STUDIO_UNSIGNED_PAID_JOB_CUTOFF =
  new Date(studioUnsignedPaidJobCutoffMs)

export type StudioRunFamilyRole = 'father' | 'mother' | 'son' | 'daughter'

/**
 * Server-resolved identity snapshot for implicit family lanes. Both the
 * canonical saved-model path and the exact generation reference are signed so
 * a role reassignment or avatar rebuild between estimate and execution cannot
 * redirect a paid job to a different private object.
 */
export type StudioRunFamilyModelPin = {
  role: StudioRunFamilyRole
  modelId: string
  modelImagePath: string
  sourceImagePath: string
  avatarSheetPath?: string
  modelName: string
  modelNotes?: string
}

export type StudioRunReferencePin = {
  id: string
  kind: 'product' | 'model'
  sourcePath: string
}

export type StudioRunScope = {
  actorUserId: string
  ownerId: string
  role: StudioAccessRole
  brandProfileId: string
  projectId: string
  productId: string | null
  sourceAssetIds: string[]
  familyModelPins?: StudioRunFamilyModelPin[]
  referencePins?: StudioRunReferencePin[]
}

export type StudioRunResolvedSelection = {
  mode: string
  architecture: 'auto' | 'advanced'
  provider: string
  model: string
  providers: string[]
  models: string[]
  plan: string[]
  paidAttemptLimit: number
}

export type StudioRunEstimateReceiptClaims = {
  version: 1
  receiptId: string
  issuedAt: string
  confirmBy: string
  executeBy: string
  requestFingerprint: string
  selectionFingerprint: string
  estimateBdt: number
  maxCostBdt: number
  scope: StudioRunScope
  selection: StudioRunResolvedSelection
}

export type StudioRunEstimate = {
  receipt: string
  receiptId: string
  confirmBy: string
  estimateBdt: number
  maxCostBdt: number
  requestFingerprint: string
  selectionFingerprint: string
  selection: StudioRunResolvedSelection
}

export class StudioRunAuthorizationError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 409) {
    super(code)
    this.name = 'StudioRunAuthorizationError'
    this.code = code
    this.status = status
  }
}

export function assertUnsignedStudioJobCompatibility(input: {
  type: unknown
  createdAt: unknown
  payload: unknown
}): { compatibilityReason: 'pre_receipt_job_before_cutoff' | 'non_paid_local_job' } {
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : {}
  if (input.type === 'image_gen' && payload.provider === 'campaign_pack_local') {
    return { compatibilityReason: 'non_paid_local_job' }
  }
  if (input.type !== 'image_gen' && input.type !== 'video_gen') {
    throw new StudioRunAuthorizationError('unsigned_generation_job_forbidden', 409)
  }
  const createdAt = input.createdAt instanceof Date
    ? input.createdAt.getTime()
    : Date.parse(String(input.createdAt ?? ''))
  if (
    !Number.isFinite(createdAt)
    || createdAt >= STUDIO_UNSIGNED_PAID_JOB_CUTOFF.getTime()
  ) {
    throw new StudioRunAuthorizationError('unsigned_generation_authorization_required', 409)
  }
  return { compatibilityReason: 'pre_receipt_job_before_cutoff' }
}

function normalized(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StudioRunAuthorizationError('invalid_run_selection', 422)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalized(item)]),
    )
  }
  throw new StudioRunAuthorizationError('invalid_run_selection', 422)
}

const STUDIO_RUN_FAMILY_ROLES = new Set<StudioRunFamilyRole>([
  'father',
  'mother',
  'son',
  'daughter',
])

export function normalizeStudioRunFamilyModelPins(
  value: unknown,
): StudioRunFamilyModelPin[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 4) {
    throw new StudioRunAuthorizationError('run_family_model_pins_invalid', 409)
  }
  const pins = value.map((item) => {
    const pin = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {}
    const role = String(pin.role ?? '') as StudioRunFamilyRole
    const modelId = String(pin.modelId ?? '').trim()
    const modelImagePath = String(pin.modelImagePath ?? '').trim()
    const sourceImagePath = String(pin.sourceImagePath ?? '').trim()
    const avatarSheetPath = typeof pin.avatarSheetPath === 'string'
      ? pin.avatarSheetPath.trim()
      : ''
    const modelName = String(pin.modelName ?? '').trim()
    const modelNotes = typeof pin.modelNotes === 'string'
      ? pin.modelNotes.trim()
      : ''
    if (
      !STUDIO_RUN_FAMILY_ROLES.has(role)
      || !modelId
      || !modelImagePath
      || !sourceImagePath
      || !modelName
    ) {
      throw new StudioRunAuthorizationError('run_family_model_pins_invalid', 409)
    }
    return {
      role,
      modelId,
      modelImagePath,
      sourceImagePath,
      ...(avatarSheetPath ? { avatarSheetPath } : {}),
      modelName,
      ...(modelNotes ? { modelNotes } : {}),
    }
  })
  if (
    new Set(pins.map((pin) => pin.role)).size !== pins.length
    || new Set(pins.map((pin) => pin.modelId)).size !== pins.length
  ) {
    throw new StudioRunAuthorizationError('run_family_model_pins_invalid', 409)
  }
  return pins.sort((left, right) => left.role.localeCompare(right.role))
}

export function canonicalStudioRunJson(value: unknown): string {
  return JSON.stringify(normalized(value))
}

export function fingerprintStudioRunValue(value: unknown): string {
  return createHash('sha256').update(canonicalStudioRunJson(value)).digest('hex')
}

function receiptSecret(): string {
  const secret = (
    process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET
    ?? process.env.NEXTAUTH_SECRET
    ?? ''
  ).trim()
  if (!secret) throw new StudioRunAuthorizationError('studio_run_secret_unavailable', 503)
  return secret
}

function encodeClaims(claims: StudioRunEstimateReceiptClaims): string {
  return Buffer.from(canonicalStudioRunJson(claims), 'utf8').toString('base64url')
}

function signature(encoded: string): string {
  return createHmac('sha256', receiptSecret()).update(encoded).digest('base64url')
}

function jobSignature(receiptId: string, fingerprint: string): string {
  return createHmac('sha256', receiptSecret())
    .update(`studio-run-job:v1:${receiptId}:${fingerprint}`)
    .digest('base64url')
}

export function signStudioRunEstimateClaims(
  claims: StudioRunEstimateReceiptClaims,
): string {
  const encoded = encodeClaims(claims)
  return `${encoded}.${signature(encoded)}`
}

export function signStudioRunJobPayload(
  receiptId: string,
  payload: unknown,
): { jobFingerprint: string; jobSignature: string } {
  const jobFingerprint = fingerprintStudioRunValue({ receiptId, payload })
  return {
    jobFingerprint,
    jobSignature: jobSignature(receiptId, jobFingerprint),
  }
}

export function assertStudioRunJobPayload(input: {
  receiptId: string
  payload: unknown
  jobFingerprint: unknown
  providedSignature: unknown
}): void {
  if (
    typeof input.jobFingerprint !== 'string'
    || typeof input.providedSignature !== 'string'
  ) {
    throw new StudioRunAuthorizationError('run_job_signature_required', 409)
  }
  const fingerprint = fingerprintStudioRunValue({
    receiptId: input.receiptId,
    payload: input.payload,
  })
  if (fingerprint !== input.jobFingerprint) {
    throw new StudioRunAuthorizationError('run_job_payload_tampered', 409)
  }
  const expectedSignature = jobSignature(input.receiptId, fingerprint)
  const provided = Buffer.from(input.providedSignature, 'utf8')
  const expected = Buffer.from(expectedSignature, 'utf8')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new StudioRunAuthorizationError('run_job_signature_tampered', 409)
  }
}

export function verifyStudioRunEstimateReceipt(
  receipt: unknown,
  options: { phase: 'confirm' | 'execute'; now?: Date },
): StudioRunEstimateReceiptClaims {
  if (typeof receipt !== 'string' || receipt.length < 40 || receipt.length > 16_000) {
    throw new StudioRunAuthorizationError('run_receipt_required', 428)
  }
  const [encoded, providedSignature, extra] = receipt.split('.')
  if (!encoded || !providedSignature || extra) {
    throw new StudioRunAuthorizationError('run_receipt_invalid', 409)
  }
  const expectedSignature = signature(encoded)
  const provided = Buffer.from(providedSignature, 'utf8')
  const expected = Buffer.from(expectedSignature, 'utf8')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new StudioRunAuthorizationError('run_receipt_tampered', 409)
  }

  let claims: StudioRunEstimateReceiptClaims
  try {
    claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StudioRunEstimateReceiptClaims
  } catch {
    throw new StudioRunAuthorizationError('run_receipt_invalid', 409)
  }
  if (
    claims?.version !== 1
    || !claims.receiptId
    || !claims.requestFingerprint
    || !claims.selectionFingerprint
    || !claims.scope?.actorUserId
    || !claims.scope?.brandProfileId
    || !claims.scope?.projectId
    || !Number.isSafeInteger(claims.estimateBdt)
    || claims.estimateBdt < 0
    || !Number.isSafeInteger(claims.maxCostBdt)
    || claims.maxCostBdt < 1
  ) {
    throw new StudioRunAuthorizationError('run_receipt_invalid', 409)
  }
  claims.scope.familyModelPins = normalizeStudioRunFamilyModelPins(
    claims.scope.familyModelPins,
  )
  const now = (options.now ?? new Date()).getTime()
  const deadline = Date.parse(options.phase === 'confirm' ? claims.confirmBy : claims.executeBy)
  if (!Number.isFinite(deadline) || deadline < now) {
    throw new StudioRunAuthorizationError(
      options.phase === 'confirm' ? 'run_estimate_stale' : 'run_authorization_expired',
      409,
    )
  }
  return claims
}

export function issueStudioRunEstimate(input: {
  scope: StudioRunScope
  request: unknown
  selection: StudioRunResolvedSelection
  estimateBdt: number
  requestedCapBdt: unknown
  now?: Date
}): StudioRunEstimate {
  const now = input.now ?? new Date()
  const estimateBdt = Math.max(0, roundMoney(input.estimateBdt))
  const maxCostBdt = normalizeStudioRunCap(input.requestedCapBdt)
  if (estimateBdt > maxCostBdt) {
    throw new StudioRunAuthorizationError('run_cost_cap_exceeded', 422)
  }
  const requestFingerprint = fingerprintStudioRunValue({
    request: input.request,
    scope: input.scope,
  })
  const selectionFingerprint = fingerprintStudioRunValue(input.selection)
  const claims: StudioRunEstimateReceiptClaims = {
    version: 1,
    receiptId: randomUUID(),
    issuedAt: now.toISOString(),
    confirmBy: new Date(now.getTime() + STUDIO_RUN_ESTIMATE_TTL_MS).toISOString(),
    executeBy: new Date(now.getTime() + STUDIO_RUN_EXECUTION_TTL_MS).toISOString(),
    requestFingerprint,
    selectionFingerprint,
    estimateBdt,
    maxCostBdt,
    scope: {
      ...input.scope,
      sourceAssetIds: [...new Set(input.scope.sourceAssetIds)].sort(),
      familyModelPins: normalizeStudioRunFamilyModelPins(
        input.scope.familyModelPins,
      ),
    },
    selection: input.selection,
  }
  return {
    receipt: signStudioRunEstimateClaims(claims),
    receiptId: claims.receiptId,
    confirmBy: claims.confirmBy,
    estimateBdt,
    maxCostBdt,
    requestFingerprint,
    selectionFingerprint,
    selection: claims.selection,
  }
}

export function assertStudioRunConfirmation(input: {
  receipt: unknown
  request: unknown
  scope: StudioRunScope
  selection: StudioRunResolvedSelection
  estimateBdt: number
  confirmation: unknown
  idempotencyKey: unknown
  maxCostBdt: unknown
  now?: Date
}): StudioRunEstimateReceiptClaims {
  const claims = verifyStudioRunEstimateReceipt(input.receipt, {
    phase: 'confirm',
    now: input.now,
  })
  const confirmation = input.confirmation === true
  if (!confirmation) throw new StudioRunAuthorizationError('explicit_confirmation_required', 428)
  if (
    typeof input.idempotencyKey !== 'string'
    || !/^[a-zA-Z0-9:_-]{12,160}$/.test(input.idempotencyKey)
  ) {
    throw new StudioRunAuthorizationError('run_idempotency_key_required', 422)
  }
  const confirmedCap = normalizeStudioRunCap(input.maxCostBdt)
  if (confirmedCap !== claims.maxCostBdt) {
    throw new StudioRunAuthorizationError('run_cost_cap_tampered', 409)
  }
  const requestFingerprint = fingerprintStudioRunValue({
    request: input.request,
    scope: input.scope,
  })
  const selectionFingerprint = fingerprintStudioRunValue(input.selection)
  const estimateBdt = Math.max(0, roundMoney(input.estimateBdt))
  if (
    requestFingerprint !== claims.requestFingerprint
    || selectionFingerprint !== claims.selectionFingerprint
    || estimateBdt !== claims.estimateBdt
  ) {
    throw new StudioRunAuthorizationError('run_estimate_changed', 409)
  }
  if (estimateBdt > claims.maxCostBdt) {
    throw new StudioRunAuthorizationError('run_cost_cap_exceeded', 422)
  }
  return claims
}
