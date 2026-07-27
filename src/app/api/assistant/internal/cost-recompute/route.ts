/**
 * POST /api/assistant/internal/cost-recompute — one-off correction of the
 * camera-listen Whisper cost over-estimate (cost audit Phase 6, 2026-07-25).
 *
 * Historical camera_listen transcribe events logged duration via bytes/2000
 * (≈16 kbps), but the listener uploads WAV 16 kHz mono 16-bit = 32000 bytes/sec,
 * so every row over-counted duration ~16× and billed the dashboard ~$17/month of
 * phantom OpenAI cost against a real bill of ~$1. The audio bytes aren't stored,
 * but the codec is fixed, so duration = stored_bytes / 32000 is the accurate
 * correction. Idempotent (skips already-corrected rows), owner-only.
 *
 * ?dry=1 (default) reports before/after without writing. Pass {"apply":true} to
 * commit. Body/query both accepted so it's easy to trigger from the dashboard.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { Prisma } from '@prisma/client'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

// WAV 16 kHz mono 16-bit. Matches the office-PC listener's upload format.
const CAMERA_BYTES_PER_SEC = 32000
const WHISPER_PER_MINUTE = 0.006
const BACKFILL_TAG = 'wav_backfill_32000'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let apply = req.nextUrl.searchParams.get('apply') === 'true'
  try {
    const body = (await req.json()) as { apply?: boolean }
    if (body?.apply === true) apply = true
  } catch { /* no body is fine — defaults to dry run */ }

  // Rows in scope: camera_listen transcribe events with a byte count that have
  // NOT already been corrected. Same predicate for the preview and the write.
  const scope = Prisma.sql`
    kind = 'transcribe'
    AND units->>'purpose' = 'camera_listen'
    AND units->>'bytes' IS NOT NULL
    AND (units->>'duration_source' IS DISTINCT FROM ${BACKFILL_TAG})`

  // Corrected cost per row mirrors calcWhisperCostUsd(bytes/32000):
  //   minutes = max(bytes/32000/60, 0.01);  cost = minutes * 0.006
  const newCostExpr = Prisma.sql`
    GREATEST((units->>'bytes')::numeric / ${CAMERA_BYTES_PER_SEC} / 60.0, 0.01) * ${WHISPER_PER_MINUTE}`

  const preview = await prisma.$queryRaw<Array<{ rows: bigint; old_usd: string; new_usd: string }>>(
    Prisma.sql`SELECT COUNT(*) AS rows,
                      COALESCE(SUM(cost_usd), 0)::text AS old_usd,
                      COALESCE(SUM(${newCostExpr}), 0)::text AS new_usd
               FROM agent_cost_events
               WHERE ${scope}`,
  )
  const rows = Number(preview[0]?.rows ?? 0)
  const oldUsd = Math.round((parseFloat(preview[0]?.old_usd ?? '0') || 0) * 100) / 100
  const newUsd = Math.round((parseFloat(preview[0]?.new_usd ?? '0') || 0) * 100) / 100

  if (!apply) {
    return Response.json({
      ok: true, dryRun: true, rows,
      oldUsd, newUsd, savedUsd: Math.round((oldUsd - newUsd) * 100) / 100,
      note: 'POST again with {"apply":true} to commit.',
    })
  }

  // Atomic correction: recompute cost_usd and rewrite the duration fields so the
  // row is self-describing and the idempotency guard trips next time.
  const updated = await prisma.$executeRaw(
    Prisma.sql`
      UPDATE agent_cost_events
      SET cost_usd = round((${newCostExpr})::numeric, 6),
          units = jsonb_set(
            jsonb_set(
              jsonb_set(units, '{duration_seconds}',
                to_jsonb(GREATEST((units->>'bytes')::numeric / ${CAMERA_BYTES_PER_SEC}, 0.01)), true),
              '{duration_source}', to_jsonb(${BACKFILL_TAG}::text), true),
            '{duration_seconds_before_backfill}', COALESCE(units->'duration_seconds', 'null'::jsonb), true)
      WHERE ${scope}`,
  )

  return Response.json({ ok: true, dryRun: false, rowsUpdated: updated, oldUsd, newUsd, savedUsd: Math.round((oldUsd - newUsd) * 100) / 100 })
}
