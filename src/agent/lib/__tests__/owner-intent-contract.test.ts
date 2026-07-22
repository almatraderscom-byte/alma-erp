import { describe, expect, it } from 'vitest'
import {
  hasAffirmativeExternalAction,
  filterToolsForOwnerIntent,
  isCopyOnlyOwnerRequest,
  validateToolCallAgainstOwnerIntent,
} from '../owner-intent-contract'

const exactIncident =
  'Family matching carousel-এর জন্য detailed primary text এখানেই লিখে দাও; কোথাও paste বা post কোরো না।'

describe('owner intent contract — copy stays copy', () => {
  it('recognizes the exact live incident as copy-only, not publish intent', () => {
    expect(isCopyOnlyOwnerRequest(exactIncident)).toBe(true)
    expect(hasAffirmativeExternalAction(exactIncident)).toBe(false)
  })

  it('blocks delegation that could broaden a copy-only request', () => {
    const violation = validateToolCallAgainstOwnerIntent({
      ownerInstructions: exactIncident,
      toolName: 'delegate_to_specialist',
    })
    expect(violation?.code).toBe('OWNER_INTENT_MISMATCH')
    expect(violation?.message).toContain('Return the complete requested copy now')
  })

  it.each(['launch_campaign', 'post_to_facebook', 'run_content_post', 'live_browser_act'])(
    'blocks generated external action %s for copy-only work',
    (toolName) => {
      expect(validateToolCallAgainstOwnerIntent({
        ownerInstructions: exactIncident,
        toolName,
      })?.code).toBe('OWNER_INTENT_MISMATCH')
    },
  )

  it('keeps factual read tools available to ground the requested copy', () => {
    expect(validateToolCallAgainstOwnerIntent({
      ownerInstructions: exactIncident,
      toolName: 'get_product',
    })).toBeNull()
  })

  it('does not block an explicitly requested write-then-publish workflow', () => {
    const ownerInstructions = 'Family matching caption লিখে তারপর Facebook-এ post করো'
    expect(isCopyOnlyOwnerRequest(ownerInstructions)).toBe(false)
    expect(hasAffirmativeExternalAction(ownerInstructions)).toBe(true)
    expect(validateToolCallAgainstOwnerIntent({
      ownerInstructions,
      toolName: 'post_to_facebook',
    })).toBeNull()
  })

  it('fails open for an unknown tool name', () => {
    expect(validateToolCallAgainstOwnerIntent({
      ownerInstructions: exactIncident,
      toolName: 'future_unknown_tool',
    })).toBeNull()
  })

  it('withholds delegation and external effects before the model sees copy-only tools', () => {
    const tools = [
      { name: 'get_product' },
      { name: 'delegate_to_specialist' },
      { name: 'launch_campaign' },
      { name: 'ask_user' },
    ]
    expect(filterToolsForOwnerIntent(exactIncident, tools).map((tool) => tool.name)).toEqual([
      'get_product',
      'ask_user',
    ])
  })
})
