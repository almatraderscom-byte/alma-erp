import { describe, it, expect } from 'vitest'
import { buildSystemPromptBlocks } from '@/agent/lib/system-prompt'

/**
 * The multi-step orchestration + live-narration rule must reach EVERY head
 * (Sonnet / Qwen / DeepSeek), because all heads build the same system prompt
 * via buildSystemPromptBlocks. These tests lock in that the block is present
 * and model-agnostic for both businesses.
 */
function stableText(businessId: 'ALMA_LIFESTYLE' | 'ALMA_TRADING'): string {
  const { stable } = buildSystemPromptBlocks({ businessId })
  return stable.map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n')
}

describe('multi-step orchestration prompt (model-agnostic)', () => {
  it('lifestyle head gets the step-by-step narration rule', () => {
    const text = stableText('ALMA_LIFESTYLE')
    // model-agnostic framing — explicitly names all three head families
    expect(text).toContain('model-agnostic')
    expect(text).toContain('Sonnet/Qwen/DeepSeek')
    // self-todo + narration + confirm-before-publish anchors
    expect(text).toContain('manage_work_todos action=add')
    expect(text).toContain('source=agent')
    expect(text).toContain('narrate')
    expect(text).toContain('confirm')
  })

  it('one-line vs multi-step branch is explicit', () => {
    const text = stableText('ALMA_LIFESTYLE')
    expect(text).toContain('এক কথার উত্তর')
    expect(text).toContain('একাধিক ধাপের কাজ')
  })

  it('trading head also gets the same orchestration rule', () => {
    const text = stableText('ALMA_TRADING')
    expect(text).toContain('model-agnostic')
    expect(text).toContain('manage_work_todos action=add')
  })

  it('still keeps make_plan/execute_plan guidance for big structured tasks', () => {
    const text = stableText('ALMA_LIFESTYLE')
    expect(text).toContain('make_plan')
    expect(text).toContain('execute_plan')
  })
})
