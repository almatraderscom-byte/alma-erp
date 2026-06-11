#!/usr/bin/env node
/**
 * Backfill agent_cost_events from agent_messages.cost_usd (idempotent).
 * Run: node scripts/backfill-cost-events.mjs
 * Requires DATABASE_URL in env.
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, conversation_id, cost_usd, tokens_in, tokens_out, created_at
     FROM agent_messages
     WHERE role = 'assistant' AND cost_usd > 0
     ORDER BY created_at ASC`,
  )

  let inserted = 0
  let skipped = 0

  for (const row of rows) {
    const dedupKey = `backfill:msg:${row.id}`
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM agent_cost_events WHERE dedup_key = $1 LIMIT 1`,
      dedupKey,
    )
    if (existing.length > 0) {
      skipped++
      continue
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO agent_cost_events (id, provider, kind, units, cost_usd, conversation_id, job_id, dedup_key, occurred_at)
       VALUES (gen_random_uuid()::text, 'anthropic', 'chat', $1::jsonb, $2, $3, $4, $5, $6)`,
      JSON.stringify({
        input_tokens: row.tokens_in ?? 0,
        output_tokens: row.tokens_out ?? 0,
        source: 'backfill',
      }),
      row.cost_usd,
      row.conversation_id,
      row.id,
      dedupKey,
      row.created_at,
    )
    inserted++
  }

  console.log(`Backfill complete: ${inserted} inserted, ${skipped} skipped (${rows.length} messages scanned)`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
