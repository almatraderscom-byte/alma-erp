#!/usr/bin/env node
/**
 * Verify API balance feature — run on feat/api-balances branch.
 * Usage: node worker/scripts/verify-api-balances.mjs
 */
import 'dotenv/config'

const APP_URL = (process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

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
  console.log('=== API Balances Verification ===\n')

  // 1. Twilio live balance
  const sid = process.env.TWILIO_ACCOUNT_SID
  const twToken = process.env.TWILIO_AUTH_TOKEN
  if (sid && twToken) {
    try {
      const auth = Buffer.from(`${sid}:${twToken}`).toString('base64')
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, {
        headers: { Authorization: `Basic ${auth}` },
      })
      const body = await res.json()
      if (res.ok && body.balance != null) {
        pass('Twilio balance fetch', JSON.stringify(body))
      } else {
        fail('Twilio balance fetch', `HTTP ${res.status} ${JSON.stringify(body)}`)
      }
    } catch (err) {
      fail('Twilio balance fetch', err.message)
    }
  } else {
    fail('Twilio balance fetch', 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set locally')
  }

  // 2–5. Internal balance refresh (needs running app + token)
  if (!INT_TOKEN) {
    fail('Balance refresh API', 'AGENT_INTERNAL_TOKEN not set')
  } else {
    try {
      const res = await fetch(`${APP_URL}/api/assistant/internal/balance-refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${INT_TOKEN}` },
      })
      const data = await res.json()
      if (!res.ok) {
        fail('Balance refresh API', `HTTP ${res.status} ${JSON.stringify(data)}`)
      } else {
        const rows = data.cache?.providers?.length ?? 0
        pass('Balance refresh API', `${rows} providers, checkedAt=${data.cache?.checkedAt}`)
        if (rows >= 6) pass('Balance table rows', `${rows} rows (expected ≥6)`)
        else fail('Balance table rows', `only ${rows} rows`)

        if (data.cache?.summaryLine) {
          pass('/khoroch summary line', data.cache.summaryLine)
        } else {
          fail('/khoroch summary line', 'empty (set credits or Twilio to populate)')
        }

        // Low balance alert dry-run
        const alerts = data.alerts ?? []
        pass('Low-balance alert compute', `${alerts.length} alert(s) ${alerts.map((a) => a.label).join(', ') || '(none)'}`)
      }
    } catch (err) {
      fail('Balance refresh API', err.message)
    }
  }

  console.log('\n=== Summary ===')
  const ok = results.filter((r) => r.ok).length
  const bad = results.filter((r) => !r.ok).length
  console.log(`${ok} passed, ${bad} failed`)
  process.exit(bad > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
