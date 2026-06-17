/**
 * Phase H live verify — real sub-agent calls against production DB + APIs.
 * Usage: npx tsx scripts/verify-tier-routing-live.ts
 */
import { readFileSync, existsSync } from 'fs'
import { resolveSubagentModel } from '../src/agent/lib/models/tier-router'
import { runSubAgent } from '../src/agent/lib/models/subagent'
import { getModel, isAnthropicModel } from '../src/agent/lib/models/registry'

function loadEnvFile(path: string) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadEnvFile('.env')
loadEnvFile('.env.production.local')

async function main() {
  const hasOr = !!process.env.OPENROUTER_API_KEY?.trim()
  console.log('OPENROUTER_API_KEY:', hasOr ? 'set' : 'MISSING (will test fallback)')

  const heavy = await resolveSubagentModel('researcher')
  console.log('researcher tier:', heavy.tier, 'model:', heavy.model.id, heavy.model.provider)
  if (heavy.tier !== 'heavy' || heavy.model.provider !== 'openrouter') {
    throw new Error('researcher must route to openrouter heavy tier')
  }

  const critical = await resolveSubagentModel('analyst')
  console.log('analyst tier:', critical.tier, 'model:', critical.model.id)
  if (critical.tier !== 'critical' || !isAnthropicModel(critical.model.id)) {
    throw new Error('analyst must stay on Claude critical tier')
  }

  const convId = `verify-tier-${Date.now()}`

  const lightResult = await runSubAgent({
    role: 'researcher',
    task: 'Phase H verify: reply with exactly one word "OK" — no tools.',
    businessId: 'ALMA_LIFESTYLE',
    conversationId: convId,
  })
  console.log('light/heavy result:', {
    success: lightResult.success,
    modelId: lightResult.modelId,
    tier: lightResult.tier,
    fallbackUsed: lightResult.fallbackUsed,
    costUsd: lightResult.costUsd,
    summary: lightResult.summary?.slice(0, 80),
  })

  const critResult = await runSubAgent({
    role: 'analyst',
    task: 'Phase H verify: reply with exactly one word "OK" — no tools, no ERP queries.',
    businessId: 'ALMA_LIFESTYLE',
    conversationId: convId,
  })
  console.log('critical result:', {
    success: critResult.success,
    modelId: critResult.modelId,
    tier: critResult.tier,
    fallbackUsed: critResult.fallbackUsed,
    costUsd: critResult.costUsd,
    summary: critResult.summary?.slice(0, 80),
  })

  if (!critResult.success || !isAnthropicModel(critResult.modelId)) {
    throw new Error('critical sub-agent must succeed on Claude')
  }

  if (hasOr) {
    if (!lightResult.success) throw new Error('heavy sub-agent failed with OpenRouter key set')
    if (lightResult.fallbackUsed) {
      console.warn('WARN: OpenRouter key set but fallback was used — check OpenRouter dashboard')
    } else if (!lightResult.modelId.startsWith('or-')) {
      throw new Error('expected OpenRouter model for heavy tier when key is set')
    }
  } else {
    if (!lightResult.fallbackUsed && lightResult.modelId.startsWith('or-')) {
      throw new Error('unexpected openrouter without key')
    }
    if (lightResult.fallbackUsed && isAnthropicModel(lightResult.modelId)) {
      throw new Error('cheap tier should fallback to Gemini, not Claude, when OpenRouter missing')
    }
    console.log('fallback path OK (no OPENROUTER_API_KEY — native Gemini expected)')
  }

  const sonnet = getModel('claude-sonnet-4-6')
  const glm = getModel('or-glm-4-32b')
  console.log(
    `\nEstimated savings vs Sonnet (per 1M blended tokens): ~$${((sonnet.inPerM + sonnet.outPerM) / 2 - (glm.inPerM + glm.outPerM) / 2).toFixed(2)}/M`,
  )
  console.log('PASS — live tier routing verified')
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
