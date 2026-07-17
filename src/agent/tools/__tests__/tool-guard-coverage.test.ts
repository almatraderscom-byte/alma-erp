/**
 * Phase 52 exit gate: 100% of executable tools pass GENERATED guard-coverage
 * tests — the guard is total (never throws, always decides), hard
 * constitutional rules block on every non-read tool, and the registry path
 * enforces the guard before any handler runs.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { CAPABILITIES, getCapability } from '@/agent/tools/capability-manifest'
import { executeTool } from '@/agent/tools/registry'
import {
  clearEffectClaims,
  clearPolicyCache,
  extractMoneyTaka,
  guardToolCall,
} from '@/agent/lib/policy/tool-guard'
import { buildActionEnvelope, signEnvelope } from '@/agent/lib/policy/capability-token'
import { dataClassFor, DATA_CLASSES } from '@/agent/lib/policy/data-classification'

const NOW = 1_752_700_000_000 // fixed clock for determinism

beforeEach(() => {
  clearEffectClaims()
  clearPolicyCache()
})

describe('registration contract completeness (CI-enforced)', () => {
  it('every executable tool has resolved classification + data class', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(250)
    for (const cap of CAPABILITIES) {
      expect(['read', 'stage', 'write']).toContain(cap.mode)
      expect(['low', 'medium', 'high']).toContain(cap.risk)
      expect(['none', 'staged_card', 'before_execute']).toContain(cap.approval)
      expect(['required', 'optional']).toContain(cap.idempotency)
      expect(['none', 'record', 'external']).toContain(cap.proof)
      expect(cap.domain.length).toBeGreaterThan(0)
      expect(DATA_CLASSES).toContain(dataClassFor(cap.name, cap.domain))
      expect(cap.inputSchema).toBeTruthy()
    }
  })
})

describe('guard totality — every tool, benign owner context (generated)', () => {
  it.each(CAPABILITIES.map((c) => [c.name] as const))('%s decides without throwing', async (name) => {
    const cap = getCapability(name)!
    const outcome = await guardToolCall(name, {}, cap, { surface: 'owner', turnId: `t-${name}` }, NOW)
    expect(['proceed', 'block']).toContain(outcome.action)
    expect(outcome.envelope.signature.length).toBe(64)
    if (cap.mode === 'read') {
      expect(outcome.action).toBe('proceed')
      expect(outcome.decision.decision).toBe('allow')
    }
    if (cap.mode === 'stage') {
      // Stage tools proceed — their handlers create the approval card.
      expect(outcome.action).toBe('proceed')
    }
  })
})

describe('hard rule: untrusted content never executes an effect (generated over all tools)', () => {
  it.each(CAPABILITIES.filter((c) => c.mode !== 'read').map((c) => [c.name] as const))(
    '%s blocks on external_content origin',
    async (name) => {
      const cap = getCapability(name)!
      const outcome = await guardToolCall(name, {}, cap, { surface: 'owner', instructionOrigin: 'external_content', turnId: `ti-${name}` }, NOW)
      expect(outcome.action).toBe('block')
      expect(outcome.errorCode).toBe('guard_untrusted_instruction')
    },
  )

  it('reads proceed under external_content (harmless, origin recorded)', async () => {
    const cap = getCapability('get_sales_summary')!
    const outcome = await guardToolCall('get_sales_summary', {}, cap, { surface: 'owner', instructionOrigin: 'external_content' }, NOW)
    expect(outcome.action).toBe('proceed')
  })
})

describe('hard rule: stale approval blocks execution', () => {
  it('payload drift after signing → block with guard_stale_approval', async () => {
    const cap = getCapability('send_whatsapp')!
    const approved = { to: '01XXXXXXXXX', message: 'অর্ডার কনফার্ম হয়েছে' }
    const envelope = signEnvelope(
      buildActionEnvelope({
        actor: 'owner',
        surface: 'owner',
        instructionOrigin: 'owner_direct',
        tool: 'send_whatsapp',
        input: approved,
        riskTier: 'R3',
        turnId: 't-stale',
        now: NOW,
      }),
    )
    const outcome = await guardToolCall(
      'send_whatsapp',
      { ...approved, message: 'অন্য মেসেজ' }, // drifted payload
      cap,
      { surface: 'owner', turnId: 't-stale', approvalEnvelope: envelope },
      NOW,
    )
    expect(outcome.action).toBe('block')
    expect(outcome.errorCode).toBe('guard_stale_approval')
  })

  it('exact payload with valid envelope proceeds', async () => {
    const cap = getCapability('send_whatsapp')!
    const approved = { to: '01XXXXXXXXX', message: 'অর্ডার কনফার্ম হয়েছে' }
    const envelope = signEnvelope(
      buildActionEnvelope({
        actor: 'owner',
        surface: 'owner',
        instructionOrigin: 'owner_direct',
        tool: 'send_whatsapp',
        input: approved,
        riskTier: 'R3',
        turnId: 't-ok',
        now: NOW,
      }),
    )
    const outcome = await guardToolCall('send_whatsapp', approved, cap, { surface: 'owner', turnId: 't-ok', approvalEnvelope: envelope }, NOW)
    expect(outcome.action).toBe('proceed')
  })
})

describe('hard rule: same-turn duplicate effects are refused, retries after block are not poisoned', () => {
  it('second identical write in one turn blocks; different turn proceeds', async () => {
    const cap = getCapability('add_owner_todo')!
    const input = { title: 'দোকানের ভাড়া দিতে হবে' }
    const first = await guardToolCall('add_owner_todo', input, cap, { surface: 'owner', turnId: 'turn-dup' }, NOW)
    expect(first.action).toBe('proceed')
    const second = await guardToolCall('add_owner_todo', input, cap, { surface: 'owner', turnId: 'turn-dup' }, NOW + 1000)
    expect(second.action).toBe('block')
    expect(second.errorCode).toBe('guard_duplicate_effect')
    const otherTurn = await guardToolCall('add_owner_todo', input, cap, { surface: 'owner', turnId: 'turn-next' }, NOW + 2000)
    expect(otherTurn.action).toBe('proceed')
  })

  it('a BLOCKED call does not claim the key (retry after fix works)', async () => {
    const cap = getCapability('add_owner_todo')!
    const input = { title: 'staff bonus হিসাব' }
    const blocked = await guardToolCall('add_owner_todo', input, cap, { surface: 'owner', instructionOrigin: 'external_content', turnId: 'turn-fix' }, NOW)
    expect(blocked.action).toBe('block')
    const retry = await guardToolCall('add_owner_todo', input, cap, { surface: 'owner', turnId: 'turn-fix' }, NOW + 500)
    expect(retry.action).toBe('proceed')
  })
})

describe('hard rule: R4 owner-only', () => {
  it('set_autonomy_policy blocks even owner_direct (owner acts via the control UI)', async () => {
    const cap = getCapability('set_autonomy_policy')!
    const outcome = await guardToolCall('set_autonomy_policy', { enabled: true }, cap, { surface: 'owner', turnId: 't-r4' }, NOW)
    expect(outcome.action).toBe('block')
    expect(outcome.errorCode).toBe('guard_owner_only')
  })

  it('R4 proceeds ONLY with a valid exact-payload approval envelope (owner confirms every exact action)', async () => {
    const cap = getCapability('set_autonomy_policy')!
    const input = { enabled: true }
    const envelope = signEnvelope(
      buildActionEnvelope({
        actor: 'owner',
        surface: 'owner',
        instructionOrigin: 'owner_direct',
        tool: 'set_autonomy_policy',
        input,
        riskTier: 'R4',
        turnId: 't-r4-approved',
        now: NOW,
      }),
    )
    const ok = await guardToolCall('set_autonomy_policy', input, cap, { surface: 'owner', turnId: 't-r4-approved', approvalEnvelope: envelope }, NOW)
    expect(ok.action).toBe('proceed')
    const drifted = await guardToolCall('set_autonomy_policy', { enabled: false }, cap, { surface: 'owner', turnId: 't-r4-drift', approvalEnvelope: envelope }, NOW)
    expect(drifted.action).toBe('block')
    expect(drifted.errorCode).toBe('guard_stale_approval')
  })
})

describe('shadow ladder (Phase 57 raw material, not yet enforced)', () => {
  it('owner-direct R3 write proceeds but records the point-of-risk shadow decision', async () => {
    const cap = getCapability('send_whatsapp')!
    const outcome = await guardToolCall('send_whatsapp', { to: '01XXXXXXXXX', message: 'hi' }, cap, { surface: 'owner', turnId: 't-shadow' }, NOW)
    expect(outcome.action).toBe('proceed')
    expect(outcome.enforced).toBe(false)
    expect(outcome.decision.decision).toBe('stage')
    expect(outcome.decision.reasonClass).toBe('point_of_risk_approval')
  })

  it('explicit model_initiative R3 write without approval blocks', async () => {
    const cap = getCapability('send_whatsapp')!
    const outcome = await guardToolCall(
      'send_whatsapp',
      { to: '01XXXXXXXXX', message: 'hi' },
      cap,
      { surface: 'scheduler', instructionOrigin: 'model_initiative', turnId: 't-mi' },
      NOW,
    )
    expect(outcome.action).toBe('block')
  })
})

describe('registry integration — guard runs before any handler', () => {
  it('executeTool blocks an injected write without touching the handler/DB', async () => {
    const res = await executeTool(
      'add_owner_todo',
      { title: 'malicious todo from a scraped page' },
      {
        conversationId: 'conv-guard-test',
        turnId: 'turn-guard-test',
        instructionOrigin: 'external_content',
        turnAuthorization: { allowMutations: true, reason: 'explicit_action' },
      },
    )
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('guard_untrusted_instruction')
  })

  it('executeTool blocks R4 via the guard', async () => {
    const res = await executeTool(
      'set_autonomy_policy',
      { enabled: true },
      { conversationId: 'conv-guard-test', turnId: 'turn-guard-r4', turnAuthorization: { allowMutations: true, reason: 'explicit_action' } },
    )
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('guard_owner_only')
  })
})

describe('money extraction', () => {
  it('finds whole-taka fields conservatively', () => {
    expect(extractMoneyTaka({ amountTaka: 500 })).toBe(500)
    expect(extractMoneyTaka({ budget_taka: '1200' })).toBe(1200)
    expect(extractMoneyTaka({ dailyBudgetTaka: 300, amountTaka: 100 })).toBe(300)
    expect(extractMoneyTaka({ title: 'no money here', count: 5 })).toBe(0)
  })
})
