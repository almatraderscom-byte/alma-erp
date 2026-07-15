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
import { prisma } from '@/lib/prisma'
import {
  listActiveWorkflowRuns,
  updateWorkflowFacts,
  ensureActiveWorkflowRun,
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
  lastAction?: string
  lastActionOk?: boolean
  lastActionAt?: string
  navHistory?: Array<{ url: string; at: string }>
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

async function activeRunOfKind(conversationId: string, kind: string) {
  const runs = await listActiveWorkflowRuns(conversationId)
  return runs.find((r) => r.kind === kind) ?? null
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
  ctx: { conversationId?: string; driveClientSeoBatch?: boolean },
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
  ctx: { conversationId?: string; businessId?: string },
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

    if (toolName === 'live_browser_act' || toolName === 'live_browser_look') {
      // Pure looks without an active run don't open one (casual "দেখাও তো" reads);
      // an ACT means real work → ensure the durable browser_setup run.
      let run = await activeRunOfKind(conversationId, 'browser_setup')
      if (!run && toolName === 'live_browser_act') {
        const tpl = getWorkflowTemplate('browser_setup')
        run = await ensureActiveWorkflowRun({
          conversationId,
          businessId: ctx.businessId,
          kind: 'browser_setup',
          goal: `লাইভ ব্রাউজার কাজ (${String(input.action ?? 'act')}${input.url ? `: ${String(input.url).slice(0, 120)}` : ''})`,
          state: tpl?.entry,
          nextAllowedTools: nextAllowedToolsFor('browser_setup', tpl?.entry ?? 'session_active'),
        })
      }
      if (!run) return
      const prev = (run.facts?.browserSession ?? {}) as BrowserSessionState
      const url = extractUrlFromLiveBrowserResult(toolName, input, data)
      const navHistory = [...(prev.navHistory ?? [])]
      if (toolName === 'live_browser_act' && String(input.action ?? '') === 'navigate' && url) {
        navHistory.push({ url, at: new Date().toISOString() })
        while (navHistory.length > 20) navHistory.shift()
      }
      const session: BrowserSessionState = {
        currentUrl: url ?? prev.currentUrl,
        lastAction: toolName === 'live_browser_look' ? 'look' : String(input.action ?? 'act'),
        lastActionOk: true,
        lastActionAt: new Date().toISOString(),
        navHistory,
      }
      await updateWorkflowFacts(run.id, { browserSession: session })
      // §H: a resuming run's first successful look re-opens the working step.
      if (toolName === 'live_browser_look' && run.state === 'resuming') {
        const { transitionWorkflowRun } = await import('./workflow-run')
        await transitionWorkflowRun({
          runId: run.id, expectedVersion: run.stateVersion,
          toStatus: 'active', toState: 'session_active', cause: 'auto',
          nextAllowedTools: nextAllowedToolsFor('browser_setup', 'session_active'),
        }).catch(() => {})
      }
      return
    }
  } catch (err) {
    console.warn('[workflow-guards] post-hook failed open:', err instanceof Error ? err.message : err)
  }
}

/** Record a FAILED live-browser act so the navigation guard lets a retry through. */
export async function onWorkflowToolFailed(
  toolName: string,
  input: Record<string, unknown>,
  ctx: { conversationId?: string },
): Promise<void> {
  if (toolName !== 'live_browser_act' || !ctx.conversationId) return
  try {
    const run = await activeRunOfKind(ctx.conversationId, 'browser_setup')
    if (!run) return
    const prev = (run.facts?.browserSession ?? {}) as BrowserSessionState
    await updateWorkflowFacts(run.id, {
      browserSession: {
        ...prev,
        lastAction: String(input.action ?? 'act'),
        lastActionOk: false,
        lastActionAt: new Date().toISOString(),
      } satisfies BrowserSessionState,
    })
  } catch { /* fail-open */ }
}
