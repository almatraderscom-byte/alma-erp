/**
 * PM-5 — delegation must not be a way around the turn's own rules.
 *
 * A specialist used to call `executeTool` with `{conversationId, businessId}`
 * and nothing else, so everything scoped to the TURN was missing for it: no
 * turnId (the same-turn duplicate guard had nothing to key on, so the head could
 * stage a card and its worker could stage the same one again), no permission
 * mode (Plan withheld effects from the head and from nobody else), no read-only
 * turn authorization, and an instruction origin that defaulted instead of
 * inheriting.
 */
import { describe, expect, it } from 'vitest'
import { delegatedToolContextFrom } from '@/agent/lib/models/subagent'

const READ_ONLY = { allowed: false, reason: 'owner asked for a status only' } as never

describe('delegatedToolContextFrom', () => {
  it('reads the packed context the registry hands to a delegating tool', () => {
    const ctx = delegatedToolContextFrom({
      role: 'researcher',
      task: 'find X',
      delegatedToolContext: {
        turnId: 'turn-77',
        permissionMode: 'plan',
        turnAuthorization: READ_ONLY,
        instructionOrigin: 'owner_direct',
      },
    })
    expect(ctx).toEqual({
      turnId: 'turn-77',
      permissionMode: 'plan',
      turnAuthorization: READ_ONLY,
      instructionOrigin: 'owner_direct',
    })
  })

  it('falls back to flat fields for callers that build their own context', () => {
    const ctx = delegatedToolContextFrom({ turnId: 'turn-9', permissionMode: 'careful' })
    expect(ctx.turnId).toBe('turn-9')
    expect(ctx.permissionMode).toBe('careful')
  })

  it('carries turnAuthorization, which is the one field a handler never sees raw', () => {
    // The registry deletes `turnAuthorization` from handler input on purpose, so
    // the packed copy is the ONLY way a read-only turn survives the hop.
    const ctx = delegatedToolContextFrom({ delegatedToolContext: { turnAuthorization: READ_ONLY } })
    expect(ctx.turnAuthorization).toBe(READ_ONLY)
  })

  it('drops an instruction origin it does not recognise instead of passing it through', () => {
    const ctx = delegatedToolContextFrom({ delegatedToolContext: { instructionOrigin: 'whatever' } })
    expect(ctx.instructionOrigin).toBeUndefined()
  })

  it('is empty when there is no turn to inherit — never invents one', () => {
    expect(delegatedToolContextFrom({})).toEqual({
      turnId: undefined,
      permissionMode: undefined,
      turnAuthorization: undefined,
      instructionOrigin: undefined,
    })
  })
})

describe('the registry packs it, so a delegating tool can forward it', () => {
  it('a handler receives delegatedToolContext even though the raw field is stripped', async () => {
    const { runRegisteredTool } = await import('@/agent/tools/registry')
    let seen: Record<string, unknown> = {}
    const fake = {
      name: 'get_current_datetime',
      description: 'test double',
      input_schema: { type: 'object' as const, properties: {} },
      handler: async (input: Record<string, unknown>) => {
        seen = input
        return { success: true, data: {} }
      },
    }
    await runRegisteredTool(fake, {}, { conversationId: 'c1' }, {
      conversationId: 'c1',
      businessId: 'ALMA_LIFESTYLE',
      turnId: 'turn-5',
      permissionMode: 'plan',
      turnAuthorization: READ_ONLY,
      instructionOrigin: 'owner_direct',
    })

    expect(seen.turnAuthorization).toBeUndefined()
    expect(seen.delegatedToolContext).toEqual({
      turnId: 'turn-5',
      permissionMode: 'plan',
      turnAuthorization: READ_ONLY,
      instructionOrigin: 'owner_direct',
    })
  })
})
