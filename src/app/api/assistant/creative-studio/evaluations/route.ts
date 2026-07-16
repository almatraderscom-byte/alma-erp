// CS10 — golden-set management + engine comparison reports.
// GET: golden cases + latest run report with the deterministic comparison.
// POST: add_case / remove_case / run (queues the worker golden_eval job).
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { randomUUID } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { GOLDEN_ENGINES, type EvalAttempt, type GoldenCase, type GoldenEngineId } from '@/lib/creative-studio/eval-types'
import { compareEngines } from '@/lib/creative-studio/model-comparison'
import { listModelsByRole } from '@/lib/tryon/model-library'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const GOLDEN_SET_KEY = 'cs_golden_set'
const REPORT_PREFIX = 'cs_eval_report:'

async function auth(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

async function readGoldenSet(): Promise<GoldenCase[]> {
  const row = await db.agentKvSetting.findUnique({ where: { key: GOLDEN_SET_KEY } })
  try {
    const parsed = row?.value ? JSON.parse(row.value) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeGoldenSet(cases: GoldenCase[]): Promise<void> {
  await db.agentKvSetting.upsert({
    where: { key: GOLDEN_SET_KEY },
    create: { key: GOLDEN_SET_KEY, value: JSON.stringify(cases) },
    update: { value: JSON.stringify(cases) },
  })
}

export async function GET(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  const cases = await readGoldenSet()
  const rows = await db.agentKvSetting.findMany({
    where: { key: { startsWith: REPORT_PREFIX } },
  })
  type ReportRow = { key: string; value: string }
  const reports = (rows as ReportRow[])
    .map((r) => {
      try { return JSON.parse(r.value) as { runId: string; finishedAt: string; attempts: EvalAttempt[]; totalCostUsd: number } } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => String(b!.finishedAt).localeCompare(String(a!.finishedAt)))

  const latest = reports[0] ?? null
  const comparison = latest ? compareEngines(latest.attempts ?? []) : null

  return Response.json({
    cases,
    runs: reports.map((r) => ({ runId: r!.runId, finishedAt: r!.finishedAt, attempts: r!.attempts?.length ?? 0, totalCostUsd: r!.totalCostUsd })),
    latest,
    comparison,
  })
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  let body: {
    action?: string
    id?: string
    productImagePath?: string
    modelRole?: string
    garmentType?: string
    seed?: number
    engines?: string[]
  }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  if (body.action === 'add_case') {
    if (!body.productImagePath?.trim()) return Response.json({ error: 'product_image_required' }, { status: 422 })
    const role = ['father', 'mother', 'single'].includes(body.modelRole ?? '') ? body.modelRole as GoldenCase['modelRole'] : 'father'
    const cases = await readGoldenSet()
    if (cases.length >= 40) return Response.json({ error: 'golden_set_full' }, { status: 422 })
    const item: GoldenCase = {
      id: `g${Date.now().toString(36)}`,
      productImagePath: body.productImagePath.trim(),
      modelRole: role,
      garmentType: body.garmentType?.trim() || 'panjabi',
      // fixed seed default → reproducible fal runs (roadmap: reproducible where supported)
      seed: Number.isFinite(body.seed) ? Math.trunc(body.seed as number) : 4242,
    }
    await writeGoldenSet([...cases, item])
    return Response.json({ ok: true, case: item })
  }

  if (body.action === 'remove_case') {
    const cases = await readGoldenSet()
    await writeGoldenSet(cases.filter((c) => c.id !== body.id))
    return Response.json({ ok: true })
  }

  if (body.action === 'run') {
    const cases = await readGoldenSet()
    if (!cases.length) return Response.json({ error: 'golden_set_empty' }, { status: 422 })
    const engines = (body.engines ?? [...GOLDEN_ENGINES]).filter((e): e is GoldenEngineId =>
      (GOLDEN_ENGINES as readonly string[]).includes(e))
    if (!engines.length) return Response.json({ error: 'no_engines' }, { status: 422 })

    // Resolve saved model image per case role — fail clearly if missing.
    const models = await listModelsByRole()
    const resolved = []
    for (const c of cases) {
      const roleKey = c.modelRole === 'single' ? 'father' : c.modelRole
      const model = models[roleKey] ?? models.father
      if (!model) return Response.json({ error: 'missing_models:father' }, { status: 422 })
      resolved.push({ ...c, modelImagePath: model.imagePath })
    }

    const runId = randomUUID().slice(0, 8)
    // cost ceiling shown honestly: fashn $0.225 + v16 $0.075 + idm ~$0.05 per case
    const perCase = engines.reduce((s, e) => s + (e === 'fashn' ? 0.225 : e === 'fal_fashn_v16' ? 0.075 : 0.05), 0)
    const costEstimate = Math.round(perCase * cases.length * 1000) / 1000

    const row = await db.agentPendingAction.create({
      data: {
        conversationId: null,
        type: 'image_gen',
        payload: {
          provider: 'golden_eval',
          runId,
          cases: resolved,
          engines,
          creativeStudio: false,
          skipTelegramCard: true,
        },
        summary: `🏅 Golden eval ${runId} — ${cases.length} case × ${engines.length} engine`,
        costEstimate,
        status: 'approved',
      },
    })
    return Response.json({ ok: true, runId, pendingActionId: row.id, estimatedCostUsd: costEstimate })
  }

  return Response.json({ error: 'unknown_action' }, { status: 400 })
}
