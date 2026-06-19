// Standalone agent-memory verification — runs the REAL search_memory SQL against
// the real database so we can confirm (not guess) whether the created_at→createdAt
// fix works and whether the owner's memories actually retrieve.
//
// Run from the project root (where .env with DATABASE_URL lives):
//     node scripts/verify-memory.mjs
// If DATABASE_URL isn't in .env, first run:  vercel env pull .env.local  (then
//     DOTENV_CONFIG_PATH=.env.local node scripts/verify-memory.mjs )
//
// Paste the whole output back.
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const log = (s) => console.log(s)
const firstLine = (e) => String(e?.message ?? e).split('\n')[0]

async function main() {
  log('=== ALMA agent-memory verification ===\n')

  if (!process.env.DATABASE_URL) {
    log('❌ DATABASE_URL not found in env. Run `vercel env pull .env.local` first,')
    log('   then: DOTENV_CONFIG_PATH=.env.local node scripts/verify-memory.mjs')
    return
  }

  // 1. OLD query (unquoted created_at) — should ERROR if the column is really createdAt
  try {
    await prisma.$queryRawUnsafe('SELECT id, created_at FROM agent_memory LIMIT 1')
    log('1. OLD query (created_at) ............ ⚠️ did NOT error (column may be mapped)')
  } catch (e) {
    log('1. OLD query (created_at) ............ ❌ errors as expected → ' + firstLine(e))
  }

  // 2. FIXED query (quoted "createdAt") — this is what search_memory now uses
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT id, scope, key, content, pinned, "createdAt" AS created_at FROM agent_memory ORDER BY "createdAt" DESC LIMIT 3',
    )
    log(`2. FIXED query ("createdAt") ......... ✅ WORKS — returned ${rows.length} row(s)`)
  } catch (e) {
    log('2. FIXED query ("createdAt") ......... ❌ STILL FAILS → ' + firstLine(e))
  }

  // 3. Reproduce the search_memory ILIKE lookup the agent runs for "wife name"
  log('\n3. search_memory ILIKE lookups:')
  for (const q of ['wife', 'Mim', 'স্ত্রী']) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        'SELECT scope, pinned, content FROM agent_memory WHERE content ILIKE $1 ORDER BY "createdAt" DESC LIMIT 5',
        `%${q}%`,
      )
      log(`   "${q}": ${rows.length} match(es)` +
        rows.map((r) => `\n      - [${r.scope}${r.pinned ? ', pinned' : ''}] ${String(r.content).slice(0, 90)}`).join(''))
    } catch (e) {
      log(`   "${q}": ❌ error → ` + firstLine(e))
    }
  }

  // 4. Inventory by scope
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT scope, COUNT(*)::int AS n, SUM(CASE WHEN pinned THEN 1 ELSE 0 END)::int AS pinned FROM agent_memory GROUP BY scope ORDER BY scope',
    )
    log('\n4. memory inventory by scope:')
    for (const r of rows) log(`   ${r.scope}: ${r.n} total (${r.pinned} pinned)`)
  } catch (e) {
    log('\n4. inventory ........................ ❌ error → ' + firstLine(e))
  }

  log('\n=== VERDICT ===')
  log('If #2 says WORKS and #3 shows the wife memory → search_memory is fixed;')
  log('the agent saying "bug not fixed" is just repeating its old diagnosis.')
  log('\n(paste this entire output back)')
}

main()
  .catch((e) => log('FATAL: ' + firstLine(e)))
  .finally(async () => { try { await prisma.$disconnect() } catch {} })
