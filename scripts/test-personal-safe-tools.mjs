#!/usr/bin/env node
/**
 * Verifies PERSONAL_SAFE_TOOLS and WORK TOOLS stay separated.
 * Run: node scripts/test-personal-safe-tools.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = readFileSync(join(root, 'src/agent/tools/registry.ts'), 'utf8')
const personalTools = readFileSync(join(root, 'src/agent/tools/personal-tools.ts'), 'utf8')

const PERSONAL_ONLY = new Set(['add_family_contact', 'list_family_contacts', 'call_family_member'])

if (!registry.includes('export const PERSONAL_SAFE_TOOLS')) {
  console.error('FAIL: PERSONAL_SAFE_TOOLS missing from registry.ts')
  process.exit(1)
}

const personalNames = [...personalTools.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])
for (const n of PERSONAL_ONLY) {
  if (!personalNames.includes(n)) {
    console.error(`FAIL: personal-tools.ts missing ${n}`)
    process.exit(1)
  }
}

const personalBlock = registry.slice(
  registry.indexOf('export const PERSONAL_SAFE_TOOLS'),
  registry.indexOf('export const PERSONAL_SAFE_TOOL_NAMES'),
)
const personalToolRefs = [...personalBlock.matchAll(/\.\.\.([A-Z_]+)/g)].map((m) => m[1])

if (!personalToolRefs.includes('FAMILY_TOOLS')) {
  console.error('FAIL: PERSONAL_SAFE_TOOLS must include FAMILY_TOOLS')
  process.exit(1)
}

const toolsBlock = registry.slice(
  registry.indexOf('export const TOOLS:'),
  registry.indexOf('// Staff-facing registry'),
)
for (const n of PERSONAL_ONLY) {
  if (toolsBlock.includes(`name: '${n}'`) || toolsBlock.includes('...FAMILY_TOOLS')) {
    console.error(`FAIL: work TOOLS must not include ${n}`)
    process.exit(1)
  }
}

if (!registry.includes('export const PERSONAL_SAFE_TOOL_NAMES')) {
  console.error('FAIL: PERSONAL_SAFE_TOOL_NAMES export missing')
  process.exit(1)
}

console.log('PASS: personal/work tool separation checks OK')
console.log(`  personal-only tools: ${[...PERSONAL_ONLY].join(', ')}`)
