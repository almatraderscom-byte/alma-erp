/**
 * Phase H self-verify — tier routing + critical Claude lock (no API keys required).
 * Usage: npx tsx scripts/verify-tier-routing.ts
 */
import {
  roleToTaskTier,
  resolveModelIdForTier,
  assertCriticalTierUsesClaude,
  fallbackModelForTier,
} from '../src/agent/lib/models/tier-router'
import { ROUTING_DEFAULTS } from '../src/agent/lib/models/routing-config'
import { getModel, isAnthropicModel } from '../src/agent/lib/models/registry'
import { assertRouterCriticalModel } from '../src/agent/lib/models/guard'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

// Light tuktak → OpenRouter cheap
const lightTier = roleToTaskTier('researcher')
assert(lightTier === 'heavy', 'researcher is heavy not light')
const researcherHeavy = resolveModelIdForTier('heavy', ROUTING_DEFAULTS)
assert(getModel(researcherHeavy).provider === 'openrouter', 'heavy should be openrouter')

const lightId = resolveModelIdForTier('light', ROUTING_DEFAULTS)
assert(getModel(lightId).provider === 'openrouter', 'light tier uses openrouter')
assert(lightId === 'or-glm-4-32b', 'default light is glm')

// Critical → Claude
const analystTier = roleToTaskTier('analyst')
assert(analystTier === 'critical', 'analyst is critical')
const criticalId = resolveModelIdForTier('critical', ROUTING_DEFAULTS)
assert(isAnthropicModel(criticalId), 'critical must be anthropic')
assertCriticalTierUsesClaude(criticalId, 'critical')

let threw = false
try {
  assertCriticalTierUsesClaude('or-glm-4-32b', 'critical')
} catch {
  threw = true
}
assert(threw, 'critical + cheap model must throw')

try {
  assertRouterCriticalModel('or-glm-4-32b', 'critical')
} catch {
  threw = true
}
assert(threw, 'router guard must reject cheap critical')

// Ops = critical (staff)
assert(roleToTaskTier('ops') === 'critical', 'ops is critical')

// Fallback chain
const fb = fallbackModelForTier('light', 'or-glm-4-32b')
assert(fb !== null && fb.id !== 'or-glm-4-32b', 'light fallback exists')

console.log('PASS — tier routing verified')
console.log('  light:', lightId, getModel(lightId).label)
console.log('  heavy:', researcherHeavy, getModel(researcherHeavy).label)
console.log('  critical:', criticalId, getModel(criticalId).label)
