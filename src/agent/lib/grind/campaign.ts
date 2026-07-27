/**
 * Campaign wiring — "fix everything that audit found" becomes a real plan.
 *
 * The model's only job here is to name a SOURCE. Everything else is derived:
 * the findings come from the stored measurement, the step graph from
 * step-builder.ts, and the plan from the existing planner. No step is authored
 * by a model, so none can be quietly dropped.
 */
import { prisma } from '@/lib/prisma'
import { createPlan, enrollPlanForAutodrive } from '@/agent/lib/planner'
import { ensureDriveConversation } from '@/agent/lib/plan-driver/drive-conversation'
import {
  attachPlan,
  createFindingSet,
  findOpenSet,
  ingestFindings,
  listFindings,
  type FindingSetRow,
  type FindingSource,
} from '@/agent/lib/grind/finding-set'
import { adapterFor } from '@/agent/lib/grind/adapters'
import { buildCampaignSteps, GRIND_STEP_TOOL, type BuiltStep } from '@/agent/lib/grind/step-builder'
import { agentStorageDownload } from '@/agent/lib/storage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const STEP_META_PREFIX = 'grind_step:'

export interface GrindStepMeta {
  setId: string
  kind: 'diagnose' | 'fix' | 'verify' | 'regression'
  family?: string
  batchKey?: string
  fingerprints: string[]
}

/**
 * What a plan step is actually about, in grind terms. Kept in KV rather than a
 * new column: the plan tables stay exactly as the rest of the app knows them.
 */
export async function putStepMeta(stepId: string, meta: GrindStepMeta): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: `${STEP_META_PREFIX}${stepId}` },
    update: { value: JSON.stringify(meta) },
    create: { key: `${STEP_META_PREFIX}${stepId}`, value: JSON.stringify(meta) },
  })
}

export async function getStepMeta(stepId: string): Promise<GrindStepMeta | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: `${STEP_META_PREFIX}${stepId}` } })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as GrindStepMeta
    return parsed && typeof parsed.setId === 'string' ? parsed : null
  } catch {
    return null
  }
}

const KIND_BY_TOOL: Record<string, GrindStepMeta['kind']> = {
  [GRIND_STEP_TOOL.diagnose]: 'diagnose',
  [GRIND_STEP_TOOL.fix]: 'fix',
  [GRIND_STEP_TOOL.verify]: 'verify',
  [GRIND_STEP_TOOL.regression]: 'regression',
}

/** The most recent finished SEO audit for a site — the campaign's baseline. */
export async function loadLatestSeoAudit(target: string): Promise<{ audit: unknown; ref: string } | null> {
  const rows = await db.agentPendingAction.findMany({
    where: { type: 'seo_audit', status: 'executed' },
    orderBy: { updatedAt: 'desc' },
    take: 25,
    select: { result: true, payload: true },
  })
  const host = normalizeTarget(target)
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>
    const url = typeof payload.url === 'string' ? payload.url : ''
    if (host && normalizeTarget(url) !== host) continue
    const artifacts = Array.isArray((row.result as Record<string, unknown> | null)?.artifacts)
      ? ((row.result as Record<string, unknown>).artifacts as string[])
      : []
    const jsonPath = artifacts.find((p) => p.endsWith('audit.json'))
    if (!jsonPath) continue
    try {
      const buf = await agentStorageDownload(jsonPath)
      return { audit: JSON.parse(buf.toString('utf8')), ref: jsonPath }
    } catch {
      continue
    }
  }
  return null
}

export function normalizeTarget(raw: string): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  try {
    return new URL(s.startsWith('http') ? s : `https://${s}`).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return s.toLowerCase()
  }
}

export interface StartCampaignResult {
  setId: string
  planId: string
  findings: number
  families: number
  steps: number
  batches: number
  reused: boolean
}

/**
 * Turn a stored measurement into a running campaign.
 *
 * Idempotent per target: an open campaign is returned as-is rather than a second
 * one being started over the same site (two campaigns fixing the same findings
 * would fight each other and double the cost).
 */
export async function startFixCampaign(input: {
  source: FindingSource
  target: string
  raw?: unknown
  baselineRef?: string | null
  conversationId?: string | null
  businessId?: string
  batchSize?: number
}): Promise<StartCampaignResult> {
  const existing = await findOpenSet(input.source, normalizeTarget(input.target))
  if (existing?.planId) {
    const rows = await listFindings(existing.id)
    return {
      setId: existing.id,
      planId: existing.planId,
      findings: rows.length,
      families: new Set(rows.map((r) => r.family)).size,
      steps: 0,
      batches: 0,
      reused: true,
    }
  }

  let raw = input.raw
  let baselineRef = input.baselineRef ?? null
  if (raw === undefined && input.source === 'seo_audit') {
    const loaded = await loadLatestSeoAudit(input.target)
    if (!loaded) throw new Error('এই সাইটের কোনো সম্পূর্ণ অডিট পাওয়া যায়নি — আগে অডিট চালাতে হবে।')
    raw = loaded.audit
    baselineRef = loaded.ref
  }

  const adapter = adapterFor(input.source)
  const inputs = adapter.ingest(raw)
  if (inputs.length === 0) throw new Error('কোনো সমস্যা পাওয়া যায়নি — ঠিক করার মতো কিছু নেই।')

  const set: FindingSetRow =
    existing ??
    (await createFindingSet({
      source: input.source,
      target: normalizeTarget(input.target),
      businessId: input.businessId,
      label: input.target,
      conversationId: input.conversationId ?? null,
      baselineRef,
    }))

  await ingestFindings(set.id, inputs)
  const findings = await listFindings(set.id)

  const built = buildCampaignSteps({ target: input.target, findings, batchSize: input.batchSize })

  const plan = await createPlan({
    goal: built.goal,
    businessId: input.businessId ?? set.businessId,
    steps: built.steps.map((s: BuiltStep) => ({
      action: s.action,
      toolName: s.toolName,
      dependsOn: s.dependsOn,
      // A grind step is worth retrying properly — a transient model/tool failure
      // must not cost the campaign a whole family.
      maxAttempts: 3,
    })),
  })

  // Link every step to what it is actually about, and stamp the batch onto the
  // findings so the verifier can re-measure exactly that batch.
  await Promise.all(
    plan.steps.map(async (step, i) => {
      const built_ = built.steps[i]
      if (!built_) return
      await putStepMeta(step.id, {
        setId: set.id,
        kind: KIND_BY_TOOL[built_.toolName] ?? 'fix',
        family: built_.family,
        batchKey: built_.batchKey,
        fingerprints: built_.fingerprints,
      })
      if (built_.batchKey && built_.fingerprints.length > 0) {
        await db.agentFinding.updateMany({
          where: { setId: set.id, fingerprint: { in: built_.fingerprints } },
          data: { batchKey: built_.batchKey },
        })
      }
    }),
  )

  await attachPlan(set.id, plan.id)
  await ensureDriveConversation({ id: plan.id, goal: built.goal, businessId: input.businessId ?? set.businessId })
  await enrollPlanForAutodrive(plan.id, {
    doneCriteria:
      `${set.target}-এর সব measured সমস্যা সত্যিই ঠিক হয়েছে — যাচাই হবে নতুন করে মেপে, ` +
      `দাবি শুনে নয়। নতুন কোনো সমস্যা তৈরি হলে কাজ শেষ নয়।`,
    maxAttempts: 8,
  })

  return {
    setId: set.id,
    planId: plan.id,
    findings: findings.length,
    families: built.familyCount,
    steps: built.steps.length,
    batches: built.batchCount,
    reused: false,
  }
}
