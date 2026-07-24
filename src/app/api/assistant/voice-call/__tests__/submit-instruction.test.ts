/**
 * PA-3 voice → execution contract tests.
 *
 * 1. Behavioral: the submit-instruction route only accepts instructions from a
 *    live OWNER call record, and enqueues a normal head turn (never executes).
 * 2. Source-level: the bot's submit function is offered on owner calls only,
 *    and its bridge path matches the deployed route path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockPrisma = vi.hoisted(() => ({
  agentVoiceCall: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  agentConversation: { findUnique: vi.fn(), create: vi.fn() },
  agentPendingAction: { create: vi.fn().mockResolvedValue({ id: 'job-fallback' }) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))

const mockTurnStatus = vi.hoisted(() => ({
  createTurn: vi.fn().mockResolvedValue('turn-1'),
  finalizeTurnIfRunning: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/agent/lib/turn-status', () => mockTurnStatus)

const mockTurnQueue = vi.hoisted(() => ({
  isTurnHandoffConfigured: vi.fn().mockReturnValue(true),
  buildTurnJobData: vi.fn((turnId: string, conversationId: string, body: { message?: string }) =>
    ({ turnId, conversationId, message: body.message })),
  enqueueTurnJob: vi.fn().mockResolvedValue('job-1'),
}))
vi.mock('@/agent/lib/turn-queue', () => mockTurnQueue)

import { POST } from '../submit-instruction/route'
import {
  VOICE_INSTRUCTION_PREFIX,
  isVoiceInstructionText,
  stripVoiceInstructionPrefix,
} from '@/agent/lib/voice-instruction'

describe('voice-instruction markers (PA-4 badge)', () => {
  it('detects and strips the prefix', () => {
    const msg = `${VOICE_INSTRUCTION_PREFIX} কাল ব্যাংকে যেতে হবে`
    expect(isVoiceInstructionText(msg)).toBe(true)
    expect(stripVoiceInstructionPrefix(msg)).toBe('কাল ব্যাংকে যেতে হবে')
    expect(isVoiceInstructionText('সাধারণ মেসেজ')).toBe(false)
  })
})

function makeReq(body: unknown, token = 'test-token') {
  return new Request('http://local/api/assistant/voice-call/submit-instruction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AGENT_INTERNAL_TOKEN = 'test-token'
  process.env.OWNER_PHONE_NUMBERS = '01779640373'
  mockTurnQueue.isTurnHandoffConfigured.mockReturnValue(true)
  mockTurnQueue.enqueueTurnJob.mockResolvedValue('job-1')
  mockTurnStatus.createTurn.mockResolvedValue('turn-1')
})

const ownerCall = {
  id: 'call-1',
  toNumber: '+8801779640373',
  conversationId: 'conv-1',
  createdAt: new Date(),
}

describe('submit-instruction route', () => {
  it('rejects a bad token', async () => {
    const res = await POST(makeReq({ instruction: 'x', callRecordId: 'call-1' }, 'wrong'))
    expect(res.status).toBe(401)
  })

  it('rejects a non-owner call record', async () => {
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue({ ...ownerCall, toNumber: '+8801311111111' })
    const res = await POST(makeReq({ instruction: 'কাজটা করো', callRecordId: 'call-1' }))
    expect(res.status).toBe(403)
    expect(mockTurnQueue.enqueueTurnJob).not.toHaveBeenCalled()
  })

  it('rejects a stale call record (replay guard)', async () => {
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue({
      ...ownerCall,
      createdAt: new Date(Date.now() - 3 * 3600_000),
    })
    const res = await POST(makeReq({ instruction: 'কাজটা করো', callRecordId: 'call-1' }))
    expect(res.status).toBe(403)
  })

  it('enqueues a marked head turn on the call conversation', async () => {
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue(ownerCall)
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ id: 'conv-1' })
    const res = await POST(makeReq({ instruction: 'ঈয়াফিকে কাল ছুটি দাও', callRecordId: 'call-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.turnId).toBe('turn-1')
    expect(mockTurnStatus.createTurn).toHaveBeenCalledWith('conv-1', { executionMode: 'worker' })
    expect(mockTurnQueue.enqueueTurnJob).toHaveBeenCalledWith(
      expect.objectContaining({ message: `${VOICE_INSTRUCTION_PREFIX} ঈয়াফিকে কাল ছুটি দাও` }),
    )
  })

  it('creates a fresh conversation when the call has none, and links it back', async () => {
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue({ ...ownerCall, conversationId: null })
    mockPrisma.agentConversation.create.mockResolvedValue({ id: 'conv-new' })
    const res = await POST(makeReq({ instruction: 'নোটে লিখে রাখো', callRecordId: 'call-1' }))
    expect(res.status).toBe(200)
    expect(mockPrisma.agentConversation.create).toHaveBeenCalled()
    expect(mockPrisma.agentVoiceCall.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { conversationId: 'conv-new' } }),
    )
  })

  it('A2 queue down → falls back to a DB-poll pending job (Upstash outage 2026-07-24)', async () => {
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue(ownerCall)
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ id: 'conv-1' })
    mockTurnQueue.isTurnHandoffConfigured.mockReturnValue(false)
    const res = await POST(makeReq({ instruction: 'কাজ', callRecordId: 'call-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(mockPrisma.agentPendingAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'voice_instruction_turn',
          status: 'approved',
          payload: expect.objectContaining({ turnId: 'turn-1', conversationId: 'conv-1' }),
        }),
      }),
    )
  })

  it('enqueue fails AND db fallback fails → honest 502', async () => {
    mockPrisma.agentVoiceCall.findUnique.mockResolvedValue(ownerCall)
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ id: 'conv-1' })
    mockTurnQueue.enqueueTurnJob.mockResolvedValue(null)
    mockPrisma.agentPendingAction.create.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(makeReq({ instruction: 'কাজ', callRecordId: 'call-1' }))
    expect(res.status).toBe(502)
    expect(mockTurnStatus.finalizeTurnIfRunning).toHaveBeenCalledWith('turn-1', 'error')
  })
})

describe('bot ↔ route source contract', () => {
  const bot = readFileSync(join(process.cwd(), 'worker/scripts/gemini-live-bot.mjs'), 'utf8')

  it('bot bridge path matches the deployed route path', () => {
    expect(bot).toContain("'/api/assistant/voice-call/submit-instruction'")
  })

  it('submit function rides the owner branch of toolDecls only', () => {
    const decls = bot.match(/toolDecls\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(decls).toContain('SUBMIT_INSTRUCTION_FN_DECL')
    // Owner gate: the submit decl must be inside the isOwnerCall() branch.
    expect(decls.match(/isOwnerCall\(\)[^\n]*SUBMIT_INSTRUCTION_FN_DECL/)).toBeTruthy()
    // And never offered to staff/contact (the non-owner fallthrough returns []).
    expect(decls).toContain('return []')
  })

  it('bot handler double-checks owner call before bridging', () => {
    const handler = bot.slice(bot.indexOf("fc.name === 'submit_boss_instruction'"))
    expect(handler.slice(0, 400)).toContain('isOwnerCall()')
  })

  it('middleware allowlists the bridge path (live bug 2026-07-23: session wall 401ed the bot)', () => {
    const mw = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8')
    expect(mw).toContain("pathname === '/api/assistant/voice-call/submit-instruction'")
  })
})
