import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatVoiceCallReport } from '@/agent/lib/voice-call-delivery'

const ROOT = process.cwd()

describe('two-way call lifecycle contract', () => {
  it('does not resume the head or mark the action executed when dialing is merely accepted', () => {
    const approve = readFileSync(join(ROOT, 'src/app/api/assistant/actions/[id]/approve/route.ts'), 'utf8')
    expect(approve).toContain("action.type === 'agent_voice_call'")
    expect(approve).toContain("status: 'approved'")
    expect(approve).toContain("action.type === 'agent_voice_call') return")
    expect(approve).toContain('terminal report')
  })

  it('keeps Telegram as an independent durable delivery channel', () => {
    const delivery = readFileSync(join(ROOT, 'src/agent/lib/voice-call-delivery.ts'), 'utf8')
    expect(delivery).toContain("['telegram', 'push', 'continuation']")
    expect(delivery).toContain("row.channel === 'telegram'")
    expect(delivery).toContain('sendOwnerText(formatted.telegram)')
    expect(delivery).toContain("telegramMode: 'never'")
  })

  it('formats a complete transcript without the old short truncation', () => {
    const report = formatVoiceCallReport({
      recipientName: 'Test Contact',
      status: 'completed',
      summary: 'কাজটি আগামীকাল হবে।',
      durationSecs: 61,
      transcript: [
        { role: 'agent', message: 'আসসালামু আলাইকুম।' },
        { role: 'caller', message: 'আগামীকাল পাঠাব।' },
      ],
    })
    expect(report.telegram).toContain('২ মিনিট')
    expect(report.telegram).toContain('এজেন্ট: আসসালামু আলাইকুম।')
    expect(report.telegram).toContain('Test Contact: আগামীকাল পাঠাব।')
    expect(report.chat).toContain('আগামীকাল')
  })
})
