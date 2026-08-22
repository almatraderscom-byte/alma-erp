/**
 * Phase 5 — workflow guards: the marketing/staff incident HARD RULEs moved out
 * of the system prompt into ENFORCED code (roadmap §F "each state exposes only
 * legal next tools" + final principle "enforce the invariant in code").
 *
 * Runs inside the validated executor (runRegisteredTool) for a small named set
 * of tools, between schema validation and the handler:
 *
 *   1. post_without_preview   — a product-post run whose generated image the
 *      owner has NOT preview-confirmed cannot stage fb/instagram post cards
 *      (prompt rule "Generated ছবির preview confirm", Boss 2026-07-13).
 *   2. product_image_without_reference — generate_image for a product the head
 *      just looked at MUST carry that product's real storagePath as
 *      referenceImageId (prompt rule "প্রোডাক্টের ছবি = আসল ছবি", 720/133 wrong-post
 *      incident). The block lists the available paths, so the fix is one call.
 *   3. delegate_in_post_pipeline — an active product-post run is the head's own
 *      job; delegating content/marketing mid-pipeline is refused (prompt rule
 *      "পোস্ট pipeline = তোমার নিজের কাজ", round 2).
 *   4. repeated_navigation (§H) — live_browser_act navigate to the URL the
 *      session is ALREADY on is refused (look first); the BrowserSessionState
 *      persisted on the browser workflow run is the source of truth.
 *
 * Every guard FAILS OPEN on lookup errors: a DB blip must never block a tool.
 * A block returns a Bangla, self-recoverable instruction — the model can always
 * satisfy the invariant and proceed.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import {
  listActiveWorkflowRuns,
  ensureActiveWorkflowRun,
  replaceWorkflowFactsIfVersion,
} from './workflow-run'
import { nextAllowedToolsFor, getWorkflowTemplate } from './workflow-templates'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface WorkflowGuardBlock {
  blocked: true
  guard: string
  error: string
}

/** Cheap prefilter — the executor consults guards only for these tools. */
export const WORKFLOW_GUARDED_TOOLS = new Set([
  'post_to_facebook',
  'publish_to_instagram',
  'generate_image',
  'delegate_to_specialist',
  'live_browser_act',
  'live_browser_look',
  'run_website_seo_audit',
  'check_website_seo_audit',
  'complete_skill_pack_run',
])

/** Tools whose SUCCESS feeds the workflow state (executor post-hook). */
export const WORKFLOW_HOOKED_TOOLS = new Set([
  'get_product',
  'extract_invoice',
  'live_browser_act',
  'live_browser_look',
])

// ── Conversation product-facts (KV) ─────────────────────────────────────────
// get_product results are stashed per conversation so the generate_image guard
// can hand the model the REAL storagePaths it should have used. TTL keeps a
// morning's product chat from blocking an evening's unrelated creative.

const PRODUCT_FACTS_TTL_MS = 45 * 60 * 1000

interface ProductFacts {
  ref: string
  images: string[]
  at: string
}

function productFactsKey(conversationId: string): string {
  return `wf_product_facts:${conversationId}`
}

async function readProductFacts(conversationId: string): Promise<ProductFacts | null> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: productFactsKey(conversationId) } })
    if (!row?.value) return null
    const parsed = JSON.parse(row.value) as ProductFacts
    if (!parsed?.at || Date.now() - new Date(parsed.at).getTime() > PRODUCT_FACTS_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

async function writeProductFacts(conversationId: string, facts: ProductFacts): Promise<void> {
  try {
    const key = productFactsKey(conversationId)
    const value = JSON.stringify(facts)
    await db.agentKvSetting.upsert({ where: { key }, update: { value }, create: { key, value } })
  } catch { /* bookkeeping only */ }
}

// ── Browser session state (roadmap §H) ──────────────────────────────────────

export interface BrowserSessionState {
  currentUrl?: string
  documentId?: string
  device?: string
  deviceId?: string
  domObservationId?: string
  allowedRefs?: string[]
  refFingerprints?: Record<string, string>
  directBrowserOwnerRequest?: string
  observationReceipt?: string
  observationTurnId?: string
  observationIssuedAt?: string
  observationExpiresAt?: string
  observationState?: 'ready' | 'pending' | 'consumed'
  pendingAct?: {
    /** Reserved before dispatch; binds this one receipt to one durable command. */
    commandId: string
    receipt: string
    turnId: string
    device: string
    deviceId: string
    currentUrl: string
    documentId: string
    domObservationId?: string
    action: string
    startedAt: string
  } | null
  lastOutcome?: {
    receipt: string
    success: boolean
    path: 'pre_dispatch' | 'handler' | 'throw' | 'effect_engine'
    errorCode?: string
    at: string
  }
  lastAction?: string
  lastActionOk?: boolean
  lastActionAt?: string
  lastTurnId?: string
  lastDevice?: string
  navHistory?: Array<{ url: string; at: string }>
}

// A normal executor reaches durable command creation immediately after receipt
// consumption. Keep a conservative grace for process death before enqueue; a
// missing command is recoverable only after first writing an exact-id terminal
// tombstone, which prevents the old executor from ever dispatching later.
export const BROWSER_PENDING_COMMAND_RESERVATION_GRACE_MS = 2 * 60_000

async function reconcilePendingBrowserAct(
  session: BrowserSessionState,
  conversationId: string,
): Promise<BrowserSessionState | null> {
  const pending = session.pendingAct
  if (!pending?.commandId) return null
  const select = {
    id: true,
    deviceId: true,
    conversationId: true,
    turnId: true,
    action: true,
    status: true,
    error: true,
    resolvedAt: true,
  }
  let command = await db.liveBrowserCommand.findUnique({
    where: { id: pending.commandId },
    select,
  })
  const matchesReservation = (row: Record<string, unknown> | null): boolean => Boolean(
    row
    && row.id === pending.commandId
    && row.deviceId === pending.deviceId
    && row.conversationId === conversationId
    && row.turnId === pending.turnId
    && row.action === pending.action,
  )

  if (!command) {
    const startedAt = Date.parse(pending.startedAt)
    if (
      !Number.isFinite(startedAt)
      || Date.now() - startedAt < BROWSER_PENDING_COMMAND_RESERVATION_GRACE_MS
    ) return null
    try {
      command = await db.liveBrowserCommand.create({
        data: {
          id: pending.commandId,
          deviceId: pending.deviceId,
          action: pending.action,
          params: {
            recoveryTombstone: true,
            observationReceipt: pending.receipt,
          },
          status: 'failed',
          error: 'pre_dispatch_abandoned: executor ended before durable command creation',
          conversationId,
          turnId: pending.turnId,
          resolvedAt: new Date(),
        },
        select,
      })
    } catch {
      // A racing original executor or reconciler may have created the reserved
      // id. Re-read it; only a terminal exact match permits replacement.
      command = await db.liveBrowserCommand.findUnique({
        where: { id: pending.commandId },
        select,
      }).catch(() => null)
    }
  }

  if (
    !matchesReservation(command as Record<string, unknown> | null)
    || (command.status !== 'done' && command.status !== 'failed')
  ) return null

  const at = command.resolvedAt instanceof Date
    ? command.resolvedAt.toISOString()
    : new Date().toISOString()
  return {
    ...session,
    observationState: 'consumed',
    pendingAct: null,
    lastOutcome: {
      receipt: pending.receipt,
      success: command.status === 'done',
      path: 'pre_dispatch',
      ...(command.status === 'failed' ? { errorCode: 'reconciled_terminal_command' } : {}),
      at,
    },
    lastAction: pending.action,
    lastActionOk: command.status === 'done',
    lastActionAt: at,
    lastTurnId: pending.turnId,
    lastDevice: pending.device,
  }
}

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u)
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return u.trim().replace(/\/$/, '')
  }
}

const REPEAT_NAV_WINDOW_MS = 10 * 60 * 1000
export const BROWSER_OBSERVATION_RECEIPT_TTL_MS = 45 * 1000
const RECEIPT_REF_ACTIONS = new Set(['click', 'type', 'select_option', 'pick_option', 'upload_file', 'hover', 'scroll_to'])

async function activeRunOfKind(conversationId: string, kind: string) {
  const runs = await listActiveWorkflowRuns(conversationId)
  return runs.find((r) => r.kind === kind) ?? null
}

function browserObservationBlock(guard: string, detail: string): WorkflowGuardBlock {
  return {
    blocked: true,
    guard,
    error:
      `WORKFLOW_BLOCKED (fresh LOOK receipt দরকার): ${detail}। ` +
      'live_browser_look দিয়ে বর্তমান page আবার দেখো, result-এর observationReceipt ও exact device দিয়ে ঠিক একটিমাত্র live_browser_act করো।',
  }
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function observationIdentity(data: unknown): {
  device: string
  deviceId: string
  currentUrl: string
  documentId: string
  domObservationId: string
  allowedRefs: string[]
  refFingerprints: Record<string, string>
} {
  const d = (data ?? {}) as Record<string, unknown>
  const page = (d.page ?? {}) as Record<string, unknown>
  const device = textField(d.device)
  const deviceId = textField(d.deviceId)
  const currentUrl = textField(d.currentUrl) || textField(page.url)
  const documentId = textField(d.documentId) || textField(page.documentId)
  const domObservationId = textField(d.domObservationId) || textField(page.domObservationId)
  const allowedRefs = Array.isArray(d.elements)
    ? [...new Set(d.elements
        .map((element) => textField((element as { ref?: unknown } | null)?.ref))
        .filter((ref) => /^[A-Za-z0-9:_-]{1,80}$/.test(ref)))]
    : []
  const refFingerprints: Record<string, string> = {}
  if (Array.isArray(d.elements)) {
    for (const element of d.elements) {
      const ref = textField((element as { ref?: unknown } | null)?.ref)
      const fingerprint = textField((element as { fingerprint?: unknown } | null)?.fingerprint)
      if (allowedRefs.includes(ref) && fingerprint && fingerprint.length <= 1000) {
        refFingerprints[ref] = fingerprint
      }
    }
  }
  return { device, deviceId, currentUrl, documentId, domObservationId, allowedRefs, refFingerprints }
}

export interface BrowserObservationReceipt {
  observationReceipt: string
  device: string
  deviceId: string
  currentUrl: string
  documentId: string
  domObservationId?: string
  directBrowserOwnerRequest?: string
  observationIssuedAt: string
  observationExpiresAt: string
}

/**
 * Persist and return a nonce for one successful browser look. A look without a
 * turn, concrete device, URL, or durable receipt is not actionable evidence.
 */
export async function recordLiveBrowserLookReceipt(
  data: unknown,
  ctx: {
    conversationId?: string
    businessId?: string
    turnId?: string
    directBrowserOwnerRequest?: string
  },
): Promise<BrowserObservationReceipt> {
  const conversationId = textField(ctx.conversationId)
  const turnId = textField(ctx.turnId)
  if (!conversationId || !turnId) throw new Error('browser_observation_context_required')

  const identity = observationIdentity(data)
  if (!identity.device) throw new Error('browser_observation_device_required')
  if (!identity.deviceId) throw new Error('browser_observation_device_id_required')
  if (!identity.currentUrl) throw new Error('browser_observation_url_required')
  if (!identity.documentId) throw new Error('browser_observation_document_required')

  let run = await activeRunOfKind(conversationId, 'browser_setup')
  if (!run) {
    const tpl = getWorkflowTemplate('browser_setup')
    run = await ensureActiveWorkflowRun({
      conversationId,
      businessId: ctx.businessId,
      kind: 'browser_setup',
      goal: `লাইভ ব্রাউজার কাজ (look: ${identity.currentUrl.slice(0, 120)})`,
      state: tpl?.entry,
      nextAllowedTools: nextAllowedToolsFor('browser_setup', tpl?.entry ?? 'session_active'),
    })
  }
  if (!run) throw new Error('browser_observation_run_unavailable')

  const now = new Date()
  const directBrowserOwnerRequest = textField(ctx.directBrowserOwnerRequest)
  const receipt: BrowserObservationReceipt = {
    observationReceipt: randomBytes(18).toString('base64url'),
    device: identity.device,
    deviceId: identity.deviceId,
    currentUrl: identity.currentUrl,
    documentId: identity.documentId,
    ...(identity.domObservationId ? { domObservationId: identity.domObservationId } : {}),
    ...(directBrowserOwnerRequest ? { directBrowserOwnerRequest } : {}),
    observationIssuedAt: now.toISOString(),
    observationExpiresAt: new Date(now.getTime() + BROWSER_OBSERVATION_RECEIPT_TTL_MS).toISOString(),
  }

  let stored = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = attempt === 0 ? run : await activeRunOfKind(conversationId, 'browser_setup')
    if (!current) throw new Error('browser_observation_run_unavailable')
    const facts = current.facts ?? {}
    const prev = (facts.browserSession ?? {}) as BrowserSessionState
    const recovered = prev.observationState === 'pending'
      ? await reconcilePendingBrowserAct(prev, conversationId)
      : prev
    if (!recovered) throw new Error('browser_observation_act_pending')
    const session: BrowserSessionState = {
      ...recovered,
      currentUrl: receipt.currentUrl,
      documentId: receipt.documentId,
      device: receipt.device,
      deviceId: receipt.deviceId,
      domObservationId: receipt.domObservationId,
      directBrowserOwnerRequest: receipt.directBrowserOwnerRequest,
      // Refs without a DOM generation are not actionable. This keeps an older
      // Companion's e1/e2 labels visible as read data without authorizing them.
      allowedRefs: receipt.domObservationId ? identity.allowedRefs : [],
      refFingerprints: receipt.domObservationId ? identity.refFingerprints : {},
      observationReceipt: receipt.observationReceipt,
      observationTurnId: turnId,
      observationIssuedAt: receipt.observationIssuedAt,
      observationExpiresAt: receipt.observationExpiresAt,
      observationState: 'ready',
      pendingAct: null,
      lastAction: 'look',
      lastActionOk: true,
      lastActionAt: now.toISOString(),
      lastTurnId: turnId,
      lastDevice: receipt.device,
    }
    stored = await replaceWorkflowFactsIfVersion({
      runId: current.id,
      expectedVersion: current.stateVersion,
      facts: { ...facts, browserSession: session },
    })
    if (stored) break
  }
  if (!stored) throw new Error('browser_observation_store_conflict')

  // Resume-by-look is useful continuity state, but receipt durability is the
  // safety boundary. A concurrent transition may win without invalidating it.
  if (stored.state === 'resuming') {
    const { transitionWorkflowRun } = await import('./workflow-run')
    await transitionWorkflowRun({
      runId: stored.id,
      expectedVersion: stored.stateVersion,
      toStatus: 'active',
      toState: 'session_active',
      cause: 'auto',
      nextAllowedTools: nextAllowedToolsFor('browser_setup', 'session_active'),
    }).catch(() => {})
  }
  return receipt
}

export interface BrowserObservationClaim {
  commandId: string
  observationReceipt: string
  device: string
  deviceId: string
  currentUrl: string
  documentId: string
  domObservationId?: string
  allowedRefs: string[]
  refFingerprints: Record<string, string>
  directBrowserOwnerRequest?: string
}

export type BrowserObservationConsumeResult =
  | WorkflowGuardBlock
  | { blocked: false; claim: BrowserObservationClaim }

/** Atomically turn a matching ready receipt into a pending one-use act. */
export async function consumeLiveBrowserObservationReceipt(
  input: Record<string, unknown>,
  ctx: { conversationId?: string; turnId?: string },
): Promise<BrowserObservationConsumeResult> {
  const conversationId = textField(ctx.conversationId)
  const turnId = textField(ctx.turnId)
  const receipt = textField(input.observationReceipt)
  const device = textField(input.device)
  if (!conversationId || !turnId) {
    return browserObservationBlock('browser_observation_context_required', 'conversation/turn context পাওয়া যায়নি')
  }
  if (!receipt || !device) {
    return browserObservationBlock('browser_observation_receipt_required', 'observationReceipt ও exact device দুটোই দিতে হবে')
  }

  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const run = await activeRunOfKind(conversationId, 'browser_setup')
      const session = (run?.facts?.browserSession ?? null) as BrowserSessionState | null
      if (!run || !session) return browserObservationBlock('fresh_browser_look_required', 'এই task-এ কোনো stored observation নেই')
      if (session.observationState !== 'ready') {
        return browserObservationBlock('fresh_browser_look_required', 'আগের receipt ইতিমধ্যে ব্যবহৃত বা pending; নতুন look দরকার')
      }
      if (session.observationReceipt !== receipt) {
        return browserObservationBlock('browser_observation_receipt_mismatch', 'receipt latest look-এর সঙ্গে মেলেনি')
      }
      if (session.observationTurnId !== turnId) {
        return browserObservationBlock('browser_observation_turn_mismatch', 'receipt অন্য turn-এর')
      }
      if (textField(session.device).toLocaleLowerCase() !== device.toLocaleLowerCase()) {
        return browserObservationBlock('browser_observation_device_mismatch', 'device latest look-এর concrete Chrome device নয়')
      }
      if (!textField(session.deviceId)) {
        return browserObservationBlock('browser_observation_device_id_missing', 'stored immutable Chrome device identity অসম্পূর্ণ')
      }
      const expiresAt = Date.parse(session.observationExpiresAt ?? '')
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return browserObservationBlock('browser_observation_expired', 'receipt-এর short lease শেষ')
      }
      if (!textField(session.currentUrl) || !textField(session.documentId)) {
        return browserObservationBlock('browser_observation_identity_missing', 'stored URL/document identity অসম্পূর্ণ')
      }
      const action = textField(input.action)
      const requestedRef = textField(input.ref)
      if (RECEIPT_REF_ACTIONS.has(action)) {
        if (!textField(session.domObservationId)) {
          return browserObservationBlock(
            'browser_observation_dom_generation_missing',
            `${action} action-এর receipt-এ DOM observation generation নেই; updated Companion দিয়ে নতুন look দরকার`,
          )
        }
        if (!requestedRef) {
          return browserObservationBlock('browser_observation_ref_required', `${action} action-এ latest look-এর observed ref বাধ্যতামূলক`)
        }
        if (!(session.allowedRefs ?? []).includes(requestedRef)) {
          return browserObservationBlock('browser_observation_ref_mismatch', `ref ${requestedRef} latest receipt-এর observed DOM refs-এ নেই`)
        }
        if (!textField(session.refFingerprints?.[requestedRef])) {
          return browserObservationBlock(
            'browser_observation_ref_fingerprint_missing',
            `ref ${requestedRef}-এর observed semantic fingerprint নেই; নতুন look দরকার`,
          )
        }
      }

      const startedAt = new Date().toISOString()
      const commandId = randomUUID()
      const next: BrowserSessionState = {
        ...session,
        observationState: 'pending',
        pendingAct: {
          commandId,
          receipt,
          turnId,
          device: session.device!,
          deviceId: session.deviceId!,
          currentUrl: session.currentUrl!,
          documentId: session.documentId!,
          domObservationId: session.domObservationId,
          action: action || 'act',
          startedAt,
        },
      }
      const claimed = await replaceWorkflowFactsIfVersion({
        runId: run.id,
        expectedVersion: run.stateVersion,
        facts: { ...(run.facts ?? {}), browserSession: next },
      })
      if (claimed) {
        return {
          blocked: false,
          claim: {
            commandId,
            observationReceipt: receipt,
            device: session.device!,
            deviceId: session.deviceId!,
            currentUrl: session.currentUrl!,
            documentId: session.documentId!,
            domObservationId: session.domObservationId,
            allowedRefs: [...(session.allowedRefs ?? [])],
            refFingerprints: { ...(session.refFingerprints ?? {}) },
            directBrowserOwnerRequest: session.directBrowserOwnerRequest,
          },
        }
      }
    }
  } catch (err) {
    console.warn('[workflow-guards] observation consume failed closed:', err instanceof Error ? err.message : err)
    return browserObservationBlock('browser_observation_unavailable', 'receipt state atomically consume করা যায়নি')
  }
  return browserObservationBlock('browser_observation_unavailable', 'receipt claim-এ concurrent conflict হয়েছে')
}

/**
 * Finalize the pending act on every executor outcome path. This never re-opens
 * a receipt. If persistence throws, the stored state remains pending and the
 * next act therefore still fails closed until a new successful look replaces it.
 */
export async function persistLiveBrowserActOutcome(
  input: Record<string, unknown>,
  data: unknown,
  ctx: { conversationId?: string; turnId?: string },
  outcome: { success: boolean; path: 'pre_dispatch' | 'handler' | 'throw' | 'effect_engine'; errorCode?: string },
): Promise<void> {
  const conversationId = textField(ctx.conversationId)
  const turnId = textField(ctx.turnId)
  const receipt = textField(input.observationReceipt)
  const device = textField(input.device)
  if (!conversationId || !turnId || !receipt || !device) throw new Error('browser_act_outcome_context_required')

  for (let attempt = 0; attempt < 4; attempt++) {
    const run = await activeRunOfKind(conversationId, 'browser_setup')
    const session = (run?.facts?.browserSession ?? null) as BrowserSessionState | null
    if (!run || !session) throw new Error('browser_act_outcome_run_unavailable')
    if (
      session.observationState === 'consumed'
      && session.lastOutcome?.receipt === receipt
    ) return
    if (
      session.observationState !== 'pending'
      || session.pendingAct?.receipt !== receipt
      || session.pendingAct.turnId !== turnId
      || session.pendingAct.device.toLocaleLowerCase() !== device.toLocaleLowerCase()
    ) throw new Error('browser_act_outcome_pending_mismatch')

    const now = new Date().toISOString()
    const url = extractUrlFromLiveBrowserResult('live_browser_act', input, data)
    const navHistory = [...(session.navHistory ?? [])]
    if (outcome.success && textField(input.action) === 'navigate' && url) {
      navHistory.push({ url, at: now })
      while (navHistory.length > 20) navHistory.shift()
    }
    const next: BrowserSessionState = {
      ...session,
      currentUrl: url ?? session.currentUrl,
      device: session.pendingAct.device,
      observationState: 'consumed',
      pendingAct: null,
      lastOutcome: {
        receipt,
        success: outcome.success,
        path: outcome.path,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        at: now,
      },
      lastAction: textField(input.action) || 'act',
      lastActionOk: outcome.success,
      lastActionAt: now,
      lastTurnId: turnId,
      lastDevice: session.pendingAct.device,
      navHistory,
    }
    const saved = await replaceWorkflowFactsIfVersion({
      runId: run.id,
      expectedVersion: run.stateVersion,
      facts: { ...(run.facts ?? {}), browserSession: next },
    })
    if (saved) return
  }
  throw new Error('browser_act_outcome_store_conflict')
}

// ── The guards ───────────────────────────────────────────────────────────────

async function guardPostWithoutPreview(conversationId: string): Promise<WorkflowGuardBlock | null> {
  const run = await activeRunOfKind(conversationId, 'product_post')
  if (!run) return null
  const facts = run.facts ?? {}
  if (facts.imageGenerated === true && facts.previewConfirmed !== true) {
    return {
      blocked: true,
      guard: 'post_without_preview',
      error:
        'WORKFLOW_BLOCKED (preview confirm বাকি): এই product-post কাজের generate করা ছবিটা Boss এখনো নিজে দেখে confirm করেননি — ' +
        'confirm ছাড়া পোস্টের কার্ড stage করা যাবে না। আগে ask_user card দাও (প্রশ্ন: "ছবিটা ঠিক আছে, নাকি change চান?" + অপশন), ' +
        'Boss "ঠিক আছে" বাছলে workflow নিজেই post ধাপ খুলে দেবে — তখন এই tool আবার call কোরো।',
    }
  }
  return null
}

async function guardProductImageWithoutReference(
  conversationId: string,
  input: Record<string, unknown>,
): Promise<WorkflowGuardBlock | null> {
  if (typeof input.referenceImageId === 'string' && input.referenceImageId.trim()) return null
  const facts = await readProductFacts(conversationId)
  if (!facts || facts.images.length === 0) return null
  const prompt = String(input.prompt ?? '')
  const mentionsRef = facts.ref && new RegExp(`(^|[^0-9])${facts.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`).test(prompt)
  const looksProduct = /product|saree|sharee|dress|kurti|panjabi|lehenga|orna|three ?piece|garment|outfit|apparel|catalog/i.test(prompt)
  if (!mentionsRef && !looksProduct) return null
  return {
    blocked: true,
    guard: 'product_image_without_reference',
    error:
      'WORKFLOW_BLOCKED (আসল ছবির reference বাকি): প্রোডাক্টের ছবি কল্পনা থেকে বানানো নিষেধ — এই conversation-এ ' +
      `প্রোডাক্ট ${facts.ref}-এর আসল ছবি আছে। generate_image আবার call করো referenceImageId-এ এর একটা দিয়ে: ` +
      `${facts.images.slice(0, 3).join(' | ')}। ` +
      'যদি এটা সত্যিই কোনো প্রোডাক্টের ছবি না হয় (generic creative), prompt থেকে প্রোডাক্ট-কোড/প্রোডাক্ট-শব্দ বাদ দিয়ে call করো।',
  }
}

async function guardDelegateInPostPipeline(
  conversationId: string,
  input: Record<string, unknown>,
): Promise<WorkflowGuardBlock | null> {
  const role = String(input.role ?? '').toLowerCase()
  if (role && !/content|market/i.test(role)) return null
  const run = await activeRunOfKind(conversationId, 'product_post')
  if (!run) return null
  return {
    blocked: true,
    guard: 'delegate_in_post_pipeline',
    error:
      'WORKFLOW_BLOCKED (post pipeline delegate নিষেধ): একটা product-post কাজ চলছে — এই pipeline তোমার নিজের হাতে শেষ করার নিয়ম ' +
      '(sub-agent conversation দেখে না, আসল ছবি আনতে পারে না — 720/133 incident)। ছবি খোঁজা → generate_image card → preview confirm → ' +
      'post card — নিজে করো, delegate নয়।',
  }
}

async function guardRepeatedNavigation(
  conversationId: string,
  input: Record<string, unknown>,
): Promise<WorkflowGuardBlock | null> {
  if (String(input.action ?? '') !== 'navigate') return null
  const target = normalizeUrl(String(input.url ?? ''))
  if (!target) return null
  const run = await activeRunOfKind(conversationId, 'browser_setup')
  const session = (run?.facts?.browserSession ?? null) as BrowserSessionState | null
  if (!session) return null
  const fresh =
    session.lastActionAt && Date.now() - new Date(session.lastActionAt).getTime() < REPEAT_NAV_WINDOW_MS
  if (!fresh) return null
  // §H rule 1: never navigate to the target the session is already on while the
  // state is fresh and the last action didn't fail — look at the page instead.
  if (session.currentUrl && normalizeUrl(session.currentUrl) === target && session.lastActionOk !== false) {
    return {
      blocked: true,
      guard: 'repeated_navigation',
      error:
        `WORKFLOW_BLOCKED (একই পেজে আবার navigate): তুমি ইতিমধ্যে ${session.currentUrl}-এ আছ — আবার navigate মানে অবস্থান হারানো। ` +
        'live_browser_look দিয়ে এখনকার পেজটা দেখো (দরকারে scrollBy দাও), তারপর পেজের ভেতরের UI (মেনু/ট্যাব/বাটন) দিয়ে এগোও।',
    }
  }
  // §H rule 3: the SAME navigation repeated shortly after it already ran once
  // (ping-pong between two pages) gets one free retry, then blocks.
  const recentSame = (session.navHistory ?? []).filter(
    (h) => normalizeUrl(h.url) === target && Date.now() - new Date(h.at).getTime() < REPEAT_NAV_WINDOW_MS,
  )
  if (recentSame.length >= 2) {
    return {
      blocked: true,
      guard: 'repeated_navigation',
      error:
        `WORKFLOW_BLOCKED (navigation লুপ): গত কিছুক্ষণে ${target}-এ ${recentSame.length} বার navigate করেছ — পথ হারিয়েছ। ` +
        'আর navigate নয়: live_browser_look দিয়ে এখনকার পেজ দেখো, আগের act-এর ফল বুঝো, তারপর পেজের ভেতরের UI দিয়ে এগোও; ' +
        'সত্যিই আটকে থাকলে save_task_checkpoint দিয়ে Boss-কে একটা স্পষ্ট প্রশ্ন করো।',
    }
  }
  return null
}

/**
 * The executor's guard gate. Returns a block (with a stable guard id) or null.
 * NEVER throws — any internal error fails open.
 */
export async function checkWorkflowGuards(
  toolName: string,
  input: Record<string, unknown>,
  ctx: { conversationId?: string; turnId?: string; driveClientSeoBatch?: boolean },
): Promise<WorkflowGuardBlock | null> {
  // Phase 7 kill switch: guards stop BLOCKING (bookkeeping hooks keep running).
  if (process.env.AGENT_WORKFLOW_GUARDS === 'false') return null
  const conversationId = ctx.conversationId
  if (!conversationId) return null
  try {
    if (
      ctx.driveClientSeoBatch
      && (
        toolName === 'live_browser_act'
        || toolName === 'live_browser_look'
        || toolName === 'run_website_seo_audit'
        || toolName === 'check_website_seo_audit'
        || toolName === 'complete_skill_pack_run'
      )
    ) {
      const { guardClientSeoBatchTool } = await import('./client-seo-batch')
      const batchBlock = await guardClientSeoBatchTool(conversationId, toolName, input)
      if (batchBlock) return { blocked: true, ...batchBlock }
    }
    switch (toolName) {
      case 'post_to_facebook':
      case 'publish_to_instagram':
        return await guardPostWithoutPreview(conversationId)
      case 'generate_image':
        return await guardProductImageWithoutReference(conversationId, input)
      case 'delegate_to_specialist':
        return await guardDelegateInPostPipeline(conversationId, input)
      // Receipt validation/consumption is an unconditional fail-closed gate in
      // the registry immediately before dispatch. This advisory guard retains
      // the independent navigation-loop protection and may be kill-switched.
      case 'live_browser_act':
        return await guardRepeatedNavigation(conversationId, input)
      default:
        return null
    }
  } catch (err) {
    console.warn('[workflow-guards] failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Post-execution hooks (facts feed the state machine) ─────────────────────

function extractUrlFromLiveBrowserResult(toolName: string, input: Record<string, unknown>, data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>
  if (toolName === 'live_browser_look' && typeof d.currentUrl === 'string') return d.currentUrl
  if (toolName === 'live_browser_act') {
    if (String(input.action ?? '') === 'navigate' && typeof input.url === 'string') return input.url
    const inner = d.result as Record<string, unknown> | undefined
    if (inner && typeof inner.url === 'string') return inner.url
  }
  return null
}

/**
 * Fire-and-forget after a SUCCESSFUL guarded/hooked tool call:
 *   - get_product → stash the real product images for the reference guard;
 *   - extract_invoice → open/advance the doc_extraction workflow (roadmap #7);
 *   - live browser tools → ensure the browser_setup workflow (roadmap #6) and
 *     persist BrowserSessionState (§H) into its facts.
 * Never throws.
 */
export async function onWorkflowToolExecuted(
  toolName: string,
  input: Record<string, unknown>,
  data: unknown,
  ctx: {
    conversationId?: string
    businessId?: string
    turnId?: string
    directBrowserOwnerRequest?: string
  },
): Promise<void> {
  const conversationId = ctx.conversationId
  if (!conversationId) return
  try {
    if (toolName === 'get_product') {
      const d = (data ?? {}) as {
        products?: Array<{ sku?: string }>
        images?: Array<{ productCode?: string; storagePath?: string }>
      }
      const images = (d.images ?? [])
        .map((i) => (typeof i?.storagePath === 'string' ? i.storagePath : ''))
        .filter(Boolean)
      const ref = String(d.images?.[0]?.productCode ?? d.products?.[0]?.sku ?? '').trim()
      if (images.length > 0 && ref) {
        await writeProductFacts(conversationId, { ref, images: images.slice(0, 6), at: new Date().toISOString() })
      }
      return
    }

    if (toolName === 'extract_invoice') {
      const run = await ensureActiveWorkflowRun({
        conversationId,
        businessId: ctx.businessId,
        kind: 'doc_extraction',
        goal: 'ইনভয়েস/ডকুমেন্ট থেকে ডেটা ERP-তে তোলা',
        state: 'extracted',
        nextAllowedTools: nextAllowedToolsFor('doc_extraction', 'extracted'),
      })
      if (run && run.state === 'document_received') {
        // Run existed from an earlier read — move it forward (best-effort).
        const { transitionWorkflowRun } = await import('./workflow-run')
        await transitionWorkflowRun({
          runId: run.id, expectedVersion: run.stateVersion,
          toState: 'extracted', cause: 'auto',
          nextAllowedTools: nextAllowedToolsFor('doc_extraction', 'extracted'),
        }).catch(() => {})
      }
      return
    }

    if (toolName === 'live_browser_look') {
      await recordLiveBrowserLookReceipt(data, ctx)
      return
    }

    if (toolName === 'live_browser_act') {
      await persistLiveBrowserActOutcome(input, data, ctx, { success: true, path: 'handler' })
      return
    }
  } catch (err) {
    console.warn('[workflow-guards] post-hook failed open:', err instanceof Error ? err.message : err)
  }
}
