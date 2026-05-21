/**
 * Alma Trading Telegram — parser & fingerprint smoke tests (no DB, no network).
 * Run: node scripts/telegram-smoke-test.mjs
 */
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Load compiled would need build; use tsx alternative — inline minimal copies for critical paths
// Instead register ts-node path — project uses ts, run via npx tsx if available

const root = path.join(__dirname, '..')

async function loadModule(rel) {
  const full = path.join(root, rel)
  const { register } = await import('tsx/esm/api').catch(() => null)
  if (register) register()
  return import(pathToFileURL(full).href)
}

let passed = 0
let failed = 0

function assert(name, cond) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}

async function main() {
  const parser = await loadModule('src/lib/trading-telegram-parser.ts')
  const ops = await loadModule('src/lib/trading-telegram-user-ops.ts')

  const { parseTelegramTradeMessage, normalizeTelegramCommandText } = parser
  const { buildDraftFingerprint } = ops

  console.log('\n=== Parser ===\n')

  const t1 = parseTelegramTradeMessage('b 500 121.5 12')
  assert('standard buy', t1.kind === 'trade' && t1.usdtAmount === 500)

  const t2 = parseTelegramTradeMessage('b500 121.5 12')
  assert('glued b500', t2.kind === 'trade' && t2.usdtAmount === 500)

  const t3 = parseTelegramTradeMessage('buy 500 121.5 12')
  assert('buy keyword', t3.kind === 'trade' && t3.tradeType === 'BUY')

  const t4 = parseTelegramTradeMessage('sh buy 500 121.5 12')
  assert('alias + buy', t4.kind === 'trade' && t4.alias === 'sh')

  const t5 = parseTelegramTradeMessage('b 500')
  assert('incomplete b 500', t5.kind === 'invalid' && t5.example?.includes('121.5'))

  const t6 = parseTelegramTradeMessage('/account')
  assert('/account', t6.kind === 'account')

  const t7 = parseTelegramTradeMessage('BUY')
  assert('keyboard BUY hint', t7.kind === 'trade_hint')

  const fp1 = buildDraftFingerprint({
    tradeType: 'BUY',
    usdtAmount: 500,
    bdtRate: 121.5,
    feeUsdt: 12,
    tradingAccountId: 'acc-a',
  })
  const fp2 = buildDraftFingerprint({
    tradeType: 'BUY',
    usdtAmount: 500,
    bdtRate: 121.5,
    feeUsdt: 12,
    tradingAccountId: 'acc-a',
  })
  const fp3 = buildDraftFingerprint({
    tradeType: 'BUY',
    usdtAmount: 500,
    bdtRate: 121.5,
    feeUsdt: 12,
    tradingAccountId: 'acc-b',
  })
  assert('fingerprint stable', fp1 === fp2)
  assert('fingerprint account-scoped', fp1 !== fp3)

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
