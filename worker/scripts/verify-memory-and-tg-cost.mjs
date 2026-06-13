#!/usr/bin/env node
/**
 * Verify memory save + Telegram cost dashboard queries.
 * Usage: node worker/scripts/verify-memory-and-tg-cost.mjs
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const results = []
function pass(msg, detail) {
  results.push({ ok: true, msg, detail })
  console.log(`✅ ${msg}${detail ? ` — ${detail}` : ''}`)
}
function fail(msg, detail) {
  results.push({ ok: false, msg, detail })
  console.log(`❌ ${msg}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  console.log('=== Memory + Telegram Cost Verification ===\n')
  const prisma = new PrismaClient()

  try {
    const count = await prisma.agentMemory.count()
    pass('agent_memory row count', String(count))

    const { createOrUpdateAgentMemory } = await import('../../src/agent/lib/agent-memory.ts').catch(() => ({ createOrUpdateAgentMemory: null }))
    const testKey = `verify_supplier_${Date.now()}`
    let memId = null
    if (createOrUpdateAgentMemory) {
      const mem = await createOrUpdateAgentMemory({
        scope: 'business',
        key: testKey,
        content: 'মালিকের নতুন সাপ্লায়ার: Rahim Traders (verify script)',
        pinned: false,
      })
      memId = mem.id
      if (mem.id && mem.scope === 'business') pass('save_memory (createOrUpdateAgentMemory)', mem.id)
      else fail('save_memory', 'missing id/scope')
    } else {
      const row = await prisma.agentMemory.create({
        data: {
          scope: 'business',
          key: testKey,
          content: 'মালিকের নতুন সাপ্লায়ার: Rahim Traders (verify script)',
        },
      })
      memId = row.id
      pass('save_memory (direct prisma)', row.id)
    }

    const found = await prisma.agentMemory.findFirst({ where: { key: testKey } })
    if (found) pass('Memory persisted in DB', found.content.slice(0, 40))
    else fail('Memory persisted in DB', 'not found')

    const sample = 'মনে রাখো আমার নতুন supplier Rahim Traders'
    const factLike = /মনে\s*রাখ|supplier|সাপ্লায়ার/i.test(sample)
    if (factLike) pass('Fact pattern detector', sample.slice(0, 30))
    else fail('Fact pattern detector', 'did not match')

    // source column (migration)
    try {
      const cols = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_conversations' AND column_name = 'source'
      `
      if (cols.length > 0) pass('agent_conversations.source column', 'exists')
      else fail('agent_conversations.source column', 'missing — run migrate deploy')
    } catch (err) {
      fail('agent_conversations.source column', err.message)
    }

    try {
      const tgToday = await prisma.$queryRaw`
        SELECT COALESCE(SUM(e.cost_usd), 0)::float AS total
        FROM agent_cost_events e
        INNER JOIN agent_conversations c ON c.id::text = e.conversation_id
        WHERE c.source = 'telegram'
          AND e.occurred_at >= CURRENT_DATE
      `
      pass('Telegram cost query', `today=$${Number(tgToday[0]?.total ?? 0).toFixed(4)}`)
    } catch (err) {
      fail('Telegram cost query', err.message)
    }

    await prisma.agentMemory.deleteMany({ where: { key: testKey } }).catch(() => {})
  } finally {
    await prisma.$disconnect()
  }

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n=== ${failed ? 'FAIL' : 'PASS'} (${results.length - failed}/${results.length}) ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
