#!/usr/bin/env node
/**
 * Smoke test — Wave Batch 2: Gemini timeouts, Supabase storage timeouts,
 * meta-messenger hardening, API route timeouts, env caching, silent catches.
 */
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

let pass = 0
let fail = 0

function check(label, ok) {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.error(`  ❌ ${label}`) }
}

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8')
}

console.log('\n── Gemini Vision Timeouts ──')
check('taste/vision.ts: AbortSignal.timeout on Gemini fetch',
  read('src/agent/lib/taste/vision.ts').includes('signal: AbortSignal.timeout(30_000)'))
check('reference/vision.ts: AbortSignal.timeout on Gemini fetch',
  read('src/agent/lib/reference/vision.ts').includes('signal: AbortSignal.timeout(20_000)'))
check('cs/gemini-vision.ts: AbortSignal.timeout on Gemini fetch',
  read('src/agent/lib/cs/gemini-vision.ts').includes('signal: AbortSignal.timeout(30_000)'))
check('vision-analyze.ts: AbortSignal.timeout on Gemini fetch',
  read('src/agent/lib/vision-analyze.ts').includes('signal: AbortSignal.timeout(30_000)'))

console.log('\n── Supabase Storage Timeouts ──')
const storageSrc = read('src/agent/lib/storage.ts')
check('storage.ts: bucket check has timeout',
  storageSrc.includes('signal: AbortSignal.timeout(10_000)'))
check('storage.ts: upload has timeout',
  storageSrc.includes('signal: AbortSignal.timeout(30_000)'))
check('storage.ts: signed URL has timeout',
  /object\/sign.*signal: AbortSignal\.timeout\(10_000\)/s.test(storageSrc))

console.log('\n── Meta Messenger Hardening ──')
const messengerSrc = read('src/agent/lib/cs/meta-messenger.ts')
check('meta-messenger.ts: graphPost has timeout',
  messengerSrc.includes('signal: AbortSignal.timeout(15_000)'))
check('meta-messenger.ts: sendTypingOn no silent catch',
  messengerSrc.includes('sendTypingOn failed'))
check('meta-messenger.ts: downloadMessengerAttachment has timeout',
  messengerSrc.includes('signal: AbortSignal.timeout(20_000)'))
check('meta-messenger.ts: fetchPostImageUrl has timeout and logs',
  messengerSrc.includes('fetchPostImageUrl failed'))
check('meta-messenger.ts: webhook signature logs on error',
  messengerSrc.includes('verifyMetaWebhookSignature failed'))

console.log('\n── API Route Fetch Timeouts ──')
check('fb-token-health: debug_token fetch has timeout',
  read('src/app/api/assistant/internal/fb-token-health/route.ts').includes('signal: AbortSignal.timeout(15_000)'))
check('tts: Google OAuth fetch has timeout',
  read('src/app/api/assistant/tts/route.ts').includes("signal: AbortSignal.timeout(10_000)"))
const ttsSrc = read('src/app/api/assistant/tts/route.ts')
check('tts: Google TTS fetch has timeout',
  ttsSrc.includes('signal: AbortSignal.timeout(15_000)'))
check('cost-reconcile: OpenAI usage fetch has timeout',
  read('src/app/api/assistant/internal/cost-reconcile/route.ts').includes('signal: AbortSignal.timeout(15_000)'))
check('product-index: image fetch has timeout',
  read('src/agent/lib/cs/product-index.ts').includes('signal: AbortSignal.timeout(20_000)'))

console.log('\n── Env Caching Fixes ──')
const resendSrc = read('src/lib/resend.ts')
check('resend.ts: no module-level FROM constant',
  !resendSrc.match(/^const FROM\s*=/m))
check('resend.ts: uses getFrom() getter',
  resendSrc.includes('function getFrom()'))
check('resend.ts: uses getResend() getter',
  resendSrc.includes('function getResend()'))
const serverApiSrc = read('src/lib/server-api.ts')
check('server-api.ts: no module-level BASE constant',
  !serverApiSrc.match(/^const BASE\s*=/m))
check('server-api.ts: uses getBase() getter',
  serverApiSrc.includes('function getBase()'))
check('server-api.ts: uses getSecret() getter',
  serverApiSrc.includes('function getSecret()'))

console.log('\n── Silent Catch Fixes (API Routes) ──')
check('chat/route.ts: no silent timingSafeEqual catch',
  read('src/app/api/assistant/chat/route.ts').includes('[chat] token compare failed'))
check('chat/route.ts: businessId backfill logs error',
  read('src/app/api/assistant/chat/route.ts').includes('businessId backfill failed'))
check('chat/route.ts: cost increment logs error',
  read('src/app/api/assistant/chat/route.ts').includes('[chat] cost increment failed'))
check('cs-run/route.ts: image download logs error',
  read('src/app/api/assistant/internal/cs-run/route.ts').includes('[cs-run] image download failed'))
check('health/route.ts: heartbeat upsert logs error',
  read('src/app/api/assistant/internal/health/route.ts').includes('heartbeat upsert failed'))
check('approve/route.ts: recordApproval logs error',
  read('src/app/api/assistant/actions/[id]/approve/route.ts').includes('[approve] recordApproval failed'))
check('approve/route.ts: trackPublishedContent logs error',
  read('src/app/api/assistant/actions/[id]/approve/route.ts').includes('[approve] trackPublishedContent failed'))
check('reject/route.ts: recordRejection logs error',
  read('src/app/api/assistant/actions/[id]/reject/route.ts').includes('[reject] recordRejection failed'))
check('reject/route.ts: taste signal capture logs error',
  read('src/app/api/assistant/actions/[id]/reject/route.ts').includes('[reject] taste signal capture failed'))
check('cost-reconcile: OpenAI fetch logs error',
  read('src/app/api/assistant/internal/cost-reconcile/route.ts').includes('[cost-reconcile] OpenAI usage fetch failed'))

console.log('\n── Silent Catch Fixes (src/lib) ──')
check('pipeline.ts: signed URL fallback logs error',
  read('src/lib/content-engine/pipeline.ts').includes('[pipeline] signed URL failed'))
check('ad-creative-gate.ts: signed URL logs error',
  read('src/lib/content-engine/ad-creative-gate.ts').includes('[ad-creative-gate] signed URL failed'))
check('caption.ts: generateCaption logs error',
  read('src/lib/content-engine/caption.ts').includes('[caption] generateCaption failed'))
check('caption.ts: generateAdCopyAngles logs error',
  read('src/lib/content-engine/caption.ts').includes('[caption] generateAdCopyAngles failed'))
check('brand-frame.ts: logo download logs error',
  read('src/lib/content-engine/brand-frame.ts').includes('[brand-frame] logo download failed'))
check('website-order-ingest.ts: customer lookup logs error',
  read('src/lib/website-order-ingest.ts').includes('[website-order-ingest] customer lookup failed'))
check('qc-gate.ts: KV setting logs error',
  read('src/lib/tryon/qc-gate.ts').includes('[qc-gate] KV setting read failed'))
check('art-director.ts: garment attrs analysis logs error',
  read('src/lib/tryon/art-director.ts').includes('[art-director] garment attrs analysis failed'))

console.log('\n── Tryon Gemini Timeouts ──')
check('art-director.ts: Gemini fetch has timeout',
  read('src/lib/tryon/art-director.ts').includes('signal: AbortSignal.timeout(30_000)'))
check('qc-gate.ts: Gemini fetch has timeout',
  read('src/lib/tryon/qc-gate.ts').includes('signal: AbortSignal.timeout(30_000)'))

console.log(`\n${'='.repeat(50)}`)
console.log(`BATCH 2 RESULT: ${pass} passed, ${fail} failed out of ${pass + fail}`)
if (fail > 0) process.exit(1)
console.log('ALL BATCH 2 CHECKS PASSED ✅\n')
