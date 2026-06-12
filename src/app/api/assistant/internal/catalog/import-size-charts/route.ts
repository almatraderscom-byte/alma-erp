import { type NextRequest } from 'next/server'
import { readFile } from 'fs/promises'
import path from 'path'
import { internalAuthHeaders } from '@/agent/lib/catalog/internal-auth'
import { importSizeChartsFromSeed } from '@/agent/lib/catalog/size-charts'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  let body: { entries?: Array<Record<string, unknown>>; useSeedFile?: boolean }
  try {
    body = await req.json().catch(() => ({}))
  } catch {
    body = {}
  }

  let entries = body.entries ?? []
  if (body.useSeedFile !== false && entries.length === 0) {
    const seedPath = path.join(process.cwd(), 'worker/data/size-charts.seed.json')
    const raw = await readFile(seedPath, 'utf8')
    const parsed = JSON.parse(raw) as { entries?: typeof entries }
    entries = parsed.entries ?? []
  }

  if (!entries.length) {
    return Response.json({ error: 'no_entries' }, { status: 400 })
  }

  const normalized = entries.map((e) => ({
    business: e.business as string | undefined,
    category: String(e.category),
    ageMinYears: Number(e.ageMinYears),
    ageMaxYears: Number(e.ageMaxYears),
    sizeLabel: String(e.sizeLabel),
    heightNote: e.heightNote ? String(e.heightNote) : undefined,
  }))

  const result = await importSizeChartsFromSeed(normalized)
  return Response.json(result)
}
