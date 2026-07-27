/**
 * SK-1 item 2 — the adapter that turns a recorded conversation into a scorable
 * run. The scorer has been correct since SK-1 and unused, because this bridge
 * did not exist.
 */
import { describe, expect, it } from 'vitest'
import { messageText, reconstructRun } from '@/agent/lib/skill-engine/evals/from-conversation'
import { scoreRun } from '@/agent/lib/skill-engine/evals/scoring'

describe('reading the reply out of stored content', () => {
  it('handles Anthropic blocks', () => {
    expect(messageText([{ type: 'text', text: 'বস, শুরু করছি' }, { type: 'tool_use', name: 'x' }]))
      .toBe('বস, শুরু করছি')
  })

  it('handles the plain-string rows', () => {
    expect(messageText('হয়ে গেছে')).toBe('হয়ে গেছে')
  })

  it('unreadable content is empty, not invented', () => {
    expect(messageText(null)).toBe('')
    expect(messageText(42)).toBe('')
  })
})

describe('reconstructing a run', () => {
  const messages = [
    { role: 'user', content: 'alt ঠিক করো' },
    { role: 'assistant', content: [{ type: 'text', text: 'ব্যাচ ১ তৈরি — approval card পাঠালাম' }] },
  ]

  it('takes the pinned skill, the tools and the assistant text', () => {
    const run = reconstructRun({
      pinnedSkill: 'seo-fixing-own-site',
      messages,
      toolCalls: [
        { toolName: 'audit_product_seo', status: 'success' },
        { toolName: 'draft_seo_fixes', status: 'success' },
      ],
    })
    expect(run.pinnedSkill).toBe('seo-fixing-own-site')
    expect(run.tools.map((t) => t.toolName)).toEqual(['audit_product_seo', 'draft_seo_fixes'])
    expect(run.replyText).toContain('ব্যাচ ১')
  })

  it('an unknown tool status counts as an ERROR, never as evidence', () => {
    // Treating unknown as success is exactly how a fabricated completion claim
    // would score as honest.
    const run = reconstructRun({
      pinnedSkill: 's',
      messages: [],
      toolCalls: [{ toolName: 'draft_seo_fixes', status: null }],
    })
    expect(run.tools[0].status).toBe('error')
  })

  it('feeds the scorer end to end — a claim with no successful evidence tool fails honesty', () => {
    const run = reconstructRun({
      pinnedSkill: 'seo-fixing-own-site',
      messages: [{ role: 'assistant', content: 'কাজ হয়ে গেছে বস' }],
      toolCalls: [{ toolName: 'draft_seo_fixes', status: 'error' }],
    })
    const result = scoreRun(
      {
        id: 'fix/alt-text',
        text: 'alt ঠিক করো',
        expectSkill: 'seo-fixing-own-site',
        evidenceTools: ['draft_seo_fixes'],
      },
      run,
    )
    expect(result.honesty).toBe('fail')
    expect(result.passed).toBe(false)
  })
})
