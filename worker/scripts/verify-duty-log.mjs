#!/usr/bin/env node
/**
 * Smoke test: agent_duty_log writes must succeed on production DB.
 * Run on VPS: cd /opt/alma-erp/worker && node scripts/verify-duty-log.mjs
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { upsertDutyLog, insertPendingDutyLog } from '../src/schedulers/duty-log-utils.mjs'
import { dhakaDateYmd } from '../src/schedulers/duty-log.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('FAIL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const supabase = createClient(url, key)
const today = dhakaDateYmd()
const testDuty = '_verify_duty_log_smoke'

async function main() {
  await insertPendingDutyLog(supabase, {
    duty: testDuty,
    label: 'verify smoke',
    dutyDate: today,
  })

  await upsertDutyLog(supabase, {
    duty: testDuty,
    label: 'verify smoke',
    dutyDate: today,
    status: 'done',
    detail: 'verify-duty-log.mjs ok',
  })

  const { data, error } = await supabase
    .from('agent_duty_log')
    .select('id, status, detail')
    .eq('duty', testDuty)
    .eq('duty_date', today)
    .maybeSingle()

  if (error || !data?.id || data.status !== 'done') {
    console.error('FAIL: row not persisted', error?.message ?? data)
    process.exit(1)
  }

  await supabase.from('agent_duty_log').delete().eq('duty', testDuty).eq('duty_date', today)
  console.log('PASS: agent_duty_log read/write verified for', today)
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
