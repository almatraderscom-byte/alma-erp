/**
 * CS12 — final certification runner (VPS): programmatic PASS/FAIL over the
 * operate-safely checklist WITHOUT paid generations. Live E2E receipts come
 * from the phase verification notes (roadmap) — this script certifies the
 * environment + wiring is still healthy at any later date.
 *
 * Run: cd worker && node scripts/run-creative-studio-certification.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'

const execFileAsync = promisify(execFile)

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const checks = []
function record(name, pass, detail = '') {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function kv(key) {
  const { data } = await supabase.from('agent_kv_settings').select('value').eq('key', key).maybeSingle()
  return data?.value ?? null
}

// 1. env keys
record('env: FAL_KEY', Boolean(process.env.FAL_KEY?.trim()))
record('env: GEMINI_API_KEY', Boolean(process.env.GEMINI_API_KEY?.trim()))
record('env: FASHN_API_KEY (direct engine option)', Boolean(process.env.FASHN_API_KEY?.trim()), 'optional — fal engines cover try-on')

// 2. toolchain
try {
  await execFileAsync('ffmpeg', ['-version'], { timeout: 10_000 })
  await execFileAsync('ffprobe', ['-version'], { timeout: 10_000 })
  record('toolchain: ffmpeg + ffprobe', true)
} catch (e) {
  record('toolchain: ffmpeg + ffprobe', false, e.message)
}

// 3. module wiring (imports resolve on this deployment)
for (const mod of [
  '../src/fal/client.mjs',
  '../src/fal/adapters/cat-vton.mjs',
  '../src/fal/adapters/fashn-v16.mjs',
  '../src/fal/adapters/flux-fill.mjs',
  '../src/family-composite.mjs',
  '../src/video-qc.mjs',
]) {
  try {
    await import(mod)
    record(`module: ${mod.replace('../src/', '')}`, true)
  } catch (e) {
    record(`module: ${mod.replace('../src/', '')}`, false, e.message?.slice(0, 120))
  }
}

// 4. endpoint allowlist integrity
try {
  const { ALLOWED_FAL_ENDPOINTS } = await import('../src/fal/client.mjs')
  const expected = ['fal-ai/cat-vton', 'fal-ai/fashn/tryon/v1.6', 'fal-ai/flux-pro/v1/fill']
  const ok = expected.every((e) => ALLOWED_FAL_ENDPOINTS.includes(e)) && ALLOWED_FAL_ENDPOINTS.length === 3
  record('fal endpoint allowlist locked (exactly 3)', ok, ALLOWED_FAL_ENDPOINTS.join(', '))
} catch (e) {
  record('fal endpoint allowlist locked', false, e.message)
}

// 5. worker heartbeat (this process may BE the worker's box; heartbeat proves pm2 app runs)
const hb = await kv('worker_heartbeat_at')
const hbAge = hb ? (Date.now() - new Date(hb).getTime()) / 1000 : null
record('worker heartbeat < 3 min', hbAge !== null && hbAge < 180, hb ? `${Math.round(hbAge)}s ago` : 'missing')

// 6. owner-tunable controls exist
record('flag: cs_fal_enabled', (await kv('cs_fal_enabled')) !== null, String(await kv('cs_fal_enabled')))
record('flag: cs_single_vton_default', (await kv('cs_single_vton_default')) !== null, String(await kv('cs_single_vton_default')))
record('flag: cs_pipeline_mode', true, String((await kv('cs_pipeline_mode')) ?? 'preview (default)'))

// 7. golden evaluation report exists
const { data: reports } = await supabase
  .from('agent_kv_settings')
  .select('key')
  .like('key', 'cs_eval_report:%')
record('golden eval report present', Boolean(reports?.length), `${reports?.length ?? 0} run(s)`)

// 8. last-7d studio failure rate (excluding owner-cancelled)
const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
const { data: recent } = await supabase
  .from('agent_pending_actions')
  .select('status, payload')
  .in('type', ['image_gen', 'video_gen', 'video_edit'])
  .gte('createdAt', since)
  .limit(500)
const studio = (recent ?? []).filter((r) => r.payload?.creativeStudio === true || r.payload?.chainInternal === true)
const failed = studio.filter((r) => r.status === 'failed').length
const rate = studio.length ? Math.round((failed / studio.length) * 100) : 0
record('7-day studio failure rate < 30%', rate < 30, `${failed}/${studio.length} = ${rate}%`)

// summary
const passCount = checks.filter((c) => c.pass).length
const summary = {
  certifiedAt: new Date().toISOString(),
  pass: passCount,
  fail: checks.length - passCount,
  checks,
}
await supabase.from('agent_kv_settings').upsert(
  { key: `cs_certification:${summary.certifiedAt.slice(0, 10)}`, value: JSON.stringify(summary) },
  { onConflict: 'key' },
)
console.log(`\n${passCount}/${checks.length} checks passed — stored as cs_certification:${summary.certifiedAt.slice(0, 10)}`)
process.exit(summary.fail === 0 ? 0 : 1)
