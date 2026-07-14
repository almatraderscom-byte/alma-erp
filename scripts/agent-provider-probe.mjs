#!/usr/bin/env node
/**
 * Phase 3 provider capability probe (roadmap: "Run a capability probe in
 * CI/staging instead of discovering rejected parameters during a live owner
 * turn").
 *
 * Sends a MINIMAL chat request per head model with the Phase 3 request-controller
 * params (tool_choice + parallel_tool_calls) and reports accept/reject, so a
 * provider that 400s on either param is caught here — not by an owner turn
 * limping through the adapter's bare-retry ladder.
 *
 * Usage:  OPENROUTER_API_KEY=... node scripts/agent-provider-probe.mjs
 * Cost:   ~4 requests × ≤16 output tokens — well under $0.01 total.
 */

const MODELS = [
  'x-ai/grok-4.20', // heavy head (owner-pinned)
  'deepseek/deepseek-v4-flash', // light head (or-deepseek-v4-flash)
  'qwen/qwen3.7-max', // cs / marketing head (or-qwen3-max)
]

const key = process.env.OPENROUTER_API_KEY?.trim()
if (!key) {
  console.error('OPENROUTER_API_KEY missing — run with the staging/prod key exported.')
  process.exit(1)
}

const TOOL = {
  type: 'function',
  function: {
    name: 'probe_noop',
    description: 'No-op probe tool. Never call it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] },
  },
}

async function probe(model, extra, label) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'ALMA agent provider probe',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      tools: [TOOL],
      max_tokens: 16,
      ...extra,
    }),
  })
  const body = await res.json().catch(() => ({}))
  const raw = body?.error?.metadata?.raw ?? body?.error?.message ?? ''
  return { model, label, ok: res.ok && !body.error, status: res.status, detail: String(raw).slice(0, 160) }
}

const results = []
for (const model of MODELS) {
  results.push(await probe(model, {}, 'baseline'))
  results.push(await probe(model, { parallel_tool_calls: false }, 'parallel_tool_calls:false'))
  results.push(await probe(model, { tool_choice: 'none' }, "tool_choice:'none'"))
  results.push(
    await probe(
      model,
      { tool_choice: { type: 'function', function: { name: 'probe_noop' } }, parallel_tool_calls: false },
      'named tool_choice + parallel:false',
    ),
  )
}

let failures = 0
for (const r of results) {
  const mark = r.ok ? '✅' : '❌'
  if (!r.ok) failures++
  console.log(`${mark} ${r.model} · ${r.label} → ${r.status}${r.detail ? ` · ${r.detail}` : ''}`)
}
console.log(failures === 0 ? '\nAll probes accepted.' : `\n${failures} probe(s) REJECTED — see above.`)
process.exit(failures === 0 ? 0 : 2)
