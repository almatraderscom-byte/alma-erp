/**
 * PA-5R — voice-approved direct dial. On a live owner-verified call the boss's
 * spoken order IS the approval: place_agent_call dials immediately (no card).
 * The flag is SERVER-injected (serverContext wins the {...input, ...ctx} merge),
 * so these tests exercise the handler contract both ways.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockPrisma = vi.hoisted(() => ({
  familyContact: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
  agentPendingAction: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  agentVoiceCall: { findFirst: vi.fn().mockResolvedValue(null) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const mockVoiceCall = vi.hoisted(() => ({ placeOutboundCall: vi.fn() }))
vi.mock('@/agent/lib/voice-call', () => mockVoiceCall)

vi.mock('@/agent/lib/urgent-rate-limit', () => ({ checkOutboundCallRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))

import { place_agent_call } from '../personal-tools'

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.familyContact.findMany.mockResolvedValue([])
  mockPrisma.agentPendingAction.findMany.mockResolvedValue([])
  mockPrisma.agentVoiceCall.findFirst.mockResolvedValue(null)
  mockPrisma.agentPendingAction.create.mockResolvedValue({ id: 'act1' })
  mockVoiceCall.placeOutboundCall.mockResolvedValue({ ok: true, callRecordId: 'call1' })
})

describe('place_agent_call — voice-approved direct dial (PA-5R)', () => {
  it('voiceCallInstruction=true → dials immediately, action pre-approved, no card', async () => {
    const res = await place_agent_call.handler({
      phone: '01712345678',
      purpose: 'ডেলিভারি কনফার্ম',
      voiceCallInstruction: true,
    })
    expect(res.success).toBe(true)
    expect((res.data as { status?: string }).status).toBe('dialing')
    expect(mockVoiceCall.placeOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({ toNumber: '+8801712345678', pendingActionId: 'act1' }),
    )
    expect(mockPrisma.agentPendingAction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) }),
    )
  })

  it('no flag → stages the normal confirm card, never dials', async () => {
    const res = await place_agent_call.handler({
      phone: '01712345678',
      purpose: 'ডেলিভারি কনফার্ম',
    })
    expect(res.success).toBe(true)
    expect((res.data as { status?: string }).status).toBe('confirm_required')
    expect(mockVoiceCall.placeOutboundCall).not.toHaveBeenCalled()
    expect(mockPrisma.agentPendingAction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'pending' }) }),
    )
  })

  it('dial failure reported honestly, action marked failed', async () => {
    mockVoiceCall.placeOutboundCall.mockResolvedValue({ ok: false, error: 'kill switch' })
    const res = await place_agent_call.handler({
      phone: '01712345678',
      purpose: 'x',
      voiceCallInstruction: true,
    })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('kill switch')
    expect(mockPrisma.agentPendingAction.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    )
  })
})

describe('server-side flag injection (spoof-proofing)', () => {
  it('core + run-owner-turn always set voiceCallInstruction in serverContext', () => {
    for (const f of ['src/agent/lib/core.ts', 'src/agent/lib/models/run-owner-turn.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, `${f} must derive the flag`).toContain('isVoiceInstructionText(lastUserText)')
      expect(src, `${f} must pass the flag in tool context`).toContain('voiceCallInstruction')
    }
  })
})

describe('call_boss_with_report — callback precision guard (PA-5R)', () => {
  it('regex: plain info asks are NOT callback requests', async () => {
    const { ownerRequestedCallback } = await import('@/agent/lib/voice-instruction')
    expect(ownerRequestedCallback(['আজকের সেলসের আপডেট দাও'])).toBe(false)
    expect(ownerRequestedCallback(['রিপোর্টটা জানাও'])).toBe(false)
    expect(ownerRequestedCallback(['আজকের সেল কত?'])).toBe(false)
  })
  it('regex: explicit call-words ARE callback requests', async () => {
    const { ownerRequestedCallback } = await import('@/agent/lib/voice-instruction')
    expect(ownerRequestedCallback(['কাজ শেষ হলে আমাকে কল করে জানাবে'])).toBe(true)
    expect(ownerRequestedCallback(['stock check koro ar call kore janabi'])).toBe(true)
    expect(ownerRequestedCallback(['৫ মিনিট পরে ফোন করে জানিও'])).toBe(true)
  })
})
