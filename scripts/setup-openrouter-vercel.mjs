#!/usr/bin/env node
/**
 * Add OPENROUTER_API_KEY to Vercel Production and redeploy.
 * Usage: OPENROUTER_API_KEY=sk-or-... node scripts/setup-openrouter-vercel.mjs
 */
import { execSync } from 'node:child_process'

const key = process.env.OPENROUTER_API_KEY?.trim()
if (!key) {
  console.error('Missing OPENROUTER_API_KEY — create one at https://openrouter.ai/keys')
  process.exit(1)
}

console.log('Adding OPENROUTER_API_KEY to Vercel Production…')
execSync(`npx vercel env add OPENROUTER_API_KEY production --force`, {
  input: key,
  stdio: ['pipe', 'inherit', 'inherit'],
})

console.log('Redeploying production…')
execSync('npx vercel deploy --prod --yes', { stdio: 'inherit' })

console.log('Run live verify: npx tsx scripts/verify-tier-routing-live.ts')
