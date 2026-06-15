#!/usr/bin/env node
/**
 * Content engine Phase 1 smoke (static contracts).
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failures.push(msg)
}

function ok(msg) {
  console.log(`PASS ${msg}`)
}

function read(rel) {
  const p = resolve(root, rel)
  if (!existsSync(p)) {
    fail(`missing ${rel}`)
    return ''
  }
  return readFileSync(p, 'utf8')
}

const schema = read('prisma/schema.prisma')
const variants = read('src/lib/content-engine/generate-variants.ts')
const brand = read('src/lib/content-engine/brand-frame.ts')
const caption = read('src/lib/content-engine/caption.ts')
const pipeline = read('src/lib/content-engine/pipeline.ts')
const tools = read('src/agent/tools/content-engine-tools.ts')
const registry = read('src/agent/tools/registry.ts')
const prompt = read('src/agent/lib/system-prompt.ts')
const modelLib = read('src/lib/tryon/model-library.ts')
const approve = read('src/app/api/assistant/actions/[id]/approve/route.ts')
const jobResult = read('src/app/api/assistant/internal/job-result/route.ts')

if (schema.includes('model ProductContentAsset')) ok('ProductContentAsset schema')
else fail('ProductContentAsset schema')

if (existsSync(resolve(root, 'prisma/migrations/20260615120000_product_content_asset/migration.sql'))) {
  ok('migration file')
} else fail('migration file')

for (const f of ['generate-variants.ts', 'brand-frame.ts', 'caption.ts', 'pipeline.ts']) {
  if (existsSync(resolve(root, `src/lib/content-engine/${f}`))) ok(`content-engine/${f}`)
  else fail(`content-engine/${f}`)
}

if (tools.includes('run_content_post') && tools.includes('add_product_asset')) ok('content-engine tools')
else fail('content-engine tools')

if (registry.includes('CONTENT_ENGINE_TOOLS')) ok('registry wired')
else fail('registry')

if (prompt.includes('CONTENT_ENGINE_ROLE_PROMPT')) ok('system prompt wired')
else fail('system prompt wired')

if (tools.includes('CONTENT ENGINE') && tools.includes('TWO approvals')) ok('content engine role prompt')
else fail('content engine role prompt')

if (modelLib.includes('ModelRole') && modelLib.includes('resolveModelByRole')) ok('model roles')
else fail('model roles')

if (variants.includes('mother_son') && variants.includes('full_family')) ok('phase2 family variants')
else fail('phase2 family variants')

if (pipeline.includes('toggleGate1VariantKeep') && pipeline.includes('regenerateGate1Variant')) {
  ok('per-variant gate1 actions')
} else fail('per-variant gate1 actions')

if (pipeline.includes('variants?: ContentVariant[]') || pipeline.includes('variants?:')) {
  ok('configurable variant set')
} else fail('configurable variant set')

if (tools.includes('mother_son') && tools.includes('full_family')) ok('run_content_post variants param')
else fail('run_content_post variants param')

if (tools.includes('mother+son') && tools.includes('full family')) ok('system prompt phase2')
else fail('system prompt phase2')

if (variants.includes('workerQuality') && variants.includes('toWorkerQuality')) ok('draft→standard worker quality')
else fail('draft→standard worker quality')

if (pipeline.includes('generateCaption(product') && pipeline.includes('captionResult.hook')) ok('early caption hook')
else fail('early caption hook')

if (brand.includes('applyBrandFrame') && brand.includes('ALMA')) ok('brand frame')
else fail('brand frame')

if (pipeline.includes('content_gate1') && pipeline.includes('content_gate2')) ok('two-gate pipeline')
else fail('two-gate pipeline')

if (approve.includes("action.type === 'content_gate1'") && approve.includes("action.type === 'content_gate2'")) {
  ok('approve handlers')
} else fail('approve handlers')

if (jobResult.includes('onPipelineRenderComplete')) ok('job-result pipeline hook')
else fail('job-result hook')

for (const f of ['pick-product.ts', 'theme.ts', 'config.ts']) {
  if (existsSync(resolve(root, `src/lib/content-engine/${f}`))) ok(`content-engine/${f}`)
  else fail(`content-engine/${f}`)
}

if (existsSync(resolve(root, 'worker/src/content-engine/run.mjs'))) ok('worker content-engine run')
else fail('worker content-engine run')

const schedulers = read('worker/src/schedulers/index.mjs')
if (schedulers.includes('content-engine-1') && schedulers.includes('content-engine-2') && schedulers.includes('content-engine-3')) {
  ok('content engine schedulers')
} else fail('content engine schedulers')

if (tools.includes('pause_content_engine') && tools.includes('resume_content_engine')) ok('pause/resume tools')
else fail('pause/resume tools')

if (tools.includes('3 posts/day') || tools.includes('autonomously prepare')) ok('phase3 autonomy prompt')
else fail('phase3 autonomy prompt')

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}

console.log('\n✓ Content engine smoke passed')
