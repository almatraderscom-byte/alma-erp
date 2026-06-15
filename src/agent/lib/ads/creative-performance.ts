/**
 * Creative angle performance log + playbook write-back (File 11 loop closure).
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type CreativePerformanceRecord = {
  campaignId: string
  campaignName?: string
  adId?: string | null
  angle: string
  productCode?: string | null
  roas?: number | null
  ctr?: number | null
  spendBdt?: number | null
  verdict?: string | null
}

export async function logCreativePerformance(row: CreativePerformanceRecord): Promise<void> {
  try {
    await db.agentCreativePerformance.create({
      data: {
        campaignId: row.campaignId,
        campaignName: row.campaignName ?? null,
        adId: row.adId ?? null,
        angle: row.angle,
        productCode: row.productCode ?? null,
        roas: row.roas ?? null,
        ctr: row.ctr ?? null,
        spendBdt: row.spendBdt != null ? Math.round(row.spendBdt) : null,
        verdict: row.verdict ?? null,
      },
    })
  } catch {
    /* best-effort */
  }
}

export async function writeWinningAngleToPlaybook(args: {
  angle: string
  roas: number
  ctr?: number
  campaignName?: string
  businessId?: string
}): Promise<void> {
  if (args.roas < 2.0) return
  const heuristic =
    `Ad creative angle "${args.angle}" ${args.campaignName ? `(${args.campaignName})` : ''} ` +
    `ROAS ${args.roas.toFixed(1)}x — future ad batches-এ এই hook বেশি ব্যবহার করুন।`
  const evidence = JSON.stringify({
    roas: args.roas,
    ctr: args.ctr ?? null,
    recordedAt: new Date().toISOString(),
  })

  try {
    const existing = await db.agentPlaybook.findFirst({
      where: {
        businessId: args.businessId ?? 'ALMA_LIFESTYLE',
        domain: 'ads',
        status: 'active',
        heuristic: { contains: args.angle.slice(0, 40) },
      },
    })
    if (existing) {
      await db.agentPlaybook.update({
        where: { id: existing.id },
        data: {
          confidence: Math.min(5, (existing.confidence ?? 2) + 1),
          evidence,
          reviewedAt: new Date(),
        },
      })
      return
    }
    await db.agentPlaybook.create({
      data: {
        businessId: args.businessId ?? 'ALMA_LIFESTYLE',
        domain: 'ads',
        heuristic,
        evidence,
        confidence: args.roas >= 3 ? 4 : 3,
        status: 'active',
      },
    })
  } catch {
    /* best-effort */
  }
}

export async function getTopCreativeAngles(limit = 5): Promise<Array<{ angle: string; avgRoas: number; count: number }>> {
  try {
    const rows = await db.agentCreativePerformance.findMany({
      where: { roas: { not: null } },
      orderBy: { recordedAt: 'desc' },
      take: 50,
      select: { angle: true, roas: true },
    })
    const byAngle = new Map<string, { sum: number; count: number }>()
    for (const r of rows) {
      const key = String(r.angle)
      const prev = byAngle.get(key) ?? { sum: 0, count: 0 }
      prev.sum += Number(r.roas ?? 0)
      prev.count += 1
      byAngle.set(key, prev)
    }
    return [...byAngle.entries()]
      .map(([angle, v]) => ({ angle, avgRoas: v.sum / v.count, count: v.count }))
      .sort((a, b) => b.avgRoas - a.avgRoas)
      .slice(0, limit)
  } catch {
    return []
  }
}
