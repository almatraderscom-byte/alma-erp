#!/usr/bin/env node
/**
 * Model library + product asset setup smoke (static contracts).
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
const modelLib = read('src/lib/tryon/model-library.ts')
const tryonTools = read('src/agent/tools/tryon-tools.ts')
const contentTools = read('src/agent/tools/content-engine-tools.ts')
const migration = read('prisma/migrations/20260615140000_agent_brand_models/migration.sql')

if (!schema.includes('model AgentBrandModel')) fail('schema missing AgentBrandModel')
else ok('AgentBrandModel in schema')

if (!schema.includes('role      String?  @unique')) fail('AgentBrandModel missing role @unique')
else ok('role field on AgentBrandModel')

if (!schema.includes('model ProductContentAsset')) fail('schema missing ProductContentAsset')
else ok('ProductContentAsset in schema')

if (!modelLib.includes('getModelByRole')) fail('model-library missing getModelByRole')
else ok('getModelByRole exported')

if (!modelLib.includes('agentBrandModel')) fail('model-library not using agentBrandModel table')
else ok('model-library uses DB table')

if (!modelLib.includes('migrateKvToDbIfNeeded')) fail('model-library missing KV migration')
else ok('KV→DB migration helper present')

if (!tryonTools.includes("role")) fail('tryon-tools missing role')
else ok('role in tryon-tools')

if (!tryonTools.includes('list_by_role')) fail('tryon-tools missing list_by_role action')
else ok('list_by_role action in tryon-tools')

if (!contentTools.includes('add_product_asset')) fail('content-engine-tools missing add_product_asset')
else ok('add_product_asset tool present')

if (!migration.includes('agent_brand_models')) fail('migration missing agent_brand_models table')
else ok('agent_brand_models migration present')

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}

console.log('\nAll model-library setup checks passed.')
