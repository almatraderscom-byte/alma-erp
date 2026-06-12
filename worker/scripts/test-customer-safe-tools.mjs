#!/usr/bin/env node
/**
 * CS-1 isolation test — CUSTOMER_SAFE_TOOLS must be exactly the allowed set.
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ALLOWED = [
  'match_product_by_image',
  'search_products',
  'get_product_details',
  'send_product_image',
  'create_order_draft',
  'handoff_to_human',
]

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const toolsSrc = readFileSync(join(root, 'src/agent/tools/cs-tools.ts'), 'utf8')
const regSrc = readFileSync(join(root, 'src/agent/tools/cs-registry.ts'), 'utf8')

const names = [...toolsSrc.matchAll(/name: '([^']+)'/g)].map((m) => m[1])
const defined = new Set(names.filter((n) => ALLOWED.includes(n)))

if (defined.size !== ALLOWED.length) {
  throw new Error(`Expected ${ALLOWED.length} CS tools, found ${[...defined].join(', ')}`)
}
for (const name of ALLOWED) {
  if (!defined.has(name)) throw new Error(`Missing: ${name}`)
}

const forbidden = ['save_memory', 'log_expense', 'outbound_phone_call', 'generate_image', 'get_salah_status']
for (const name of defined) {
  if (forbidden.some((f) => name.includes(f))) throw new Error(`Forbidden tool in CS registry: ${name}`)
}

if (regSrc.includes('...ERP_TOOLS') || regSrc.includes('...FINANCE_TOOLS') || regSrc.includes('...REMINDER_TOOLS')) {
  throw new Error('cs-registry must not spread owner tool bundles')
}

console.log('✅ CUSTOMER_SAFE_TOOLS isolation OK:', ALLOWED.join(', '))
