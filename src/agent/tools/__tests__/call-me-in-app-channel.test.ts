/**
 * Owner rule 2026-08-27: bare "কল দাও" follows the abroad toggle — in BD the
 * boss's NUMBER rings (WhatsApp → PSTN ladder), abroad (or explicit app ask)
 * the ALMA app rings. These tests pin the call_me_in_app routing contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn() },
  agentCallEscalation: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

vi.mock('@/agent/lib/urgent-rate-limit', () => ({ checkOutboundCallRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))

const mockAppCall = vi.hoisted(() => ({
  ringOwnerApp: vi.fn(),
  agentAppCallEnabled: vi.fn().mockReturnValue(true),
}))
vi.mock('@/agent/lib/agent-app-call', () => mockAppCall)

const mockLadder = vi.hoisted(() => ({
  queueCallEscalation: vi.fn(),
  startEscalationLadder: vi.fn(),
}))
vi.mock('@/agent/lib/proactive-call', () => mockLadder)

import { call_me_in_app } from '../personal-tools'

const abroadKv = (on: boolean) =>
  mockPrisma.agentKvSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) =>
    Promise.resolve(where.key === 'owner_abroad_calls_off' && on ? { value: 'true' } : null),
  )

beforeEach(() => {
  vi.clearAllMocks()
  mockAppCall.agentAppCallEnabled.mockReturnValue(true)
  mockAppCall.ringOwnerApp.mockResolvedValue({ ok: true, callId: 'app-1' })
  mockPrisma.agentCallEscalation.findFirst.mockResolvedValue(null)
  mockPrisma.agentCallEscalation.findUnique.mockResolvedValue({ createdAt: new Date() })
  mockPrisma.agentCallEscalation.update.mockResolvedValue({})
  mockLadder.queueCallEscalation.mockResolvedValue('esc-1')
  mockLadder.startEscalationLadder.mockResolvedValue({ ok: true, stage: 'wa_calling' })
})

describe('call_me_in_app — channel follows the abroad toggle', () => {
  it('in BD (toggle OFF) → dials his number via the ladder, app never rings', async () => {
    abroadKv(false)
    const res = await call_me_in_app.handler({ purpose: 'দরকারি কথা' })
    expect(res.success).toBe(true)
    expect((res.data as { status?: string }).status).toBe('phone_calling')
    expect(mockLadder.queueCallEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'boss_callback' }),
    )
    expect(mockLadder.startEscalationLadder).toHaveBeenCalledWith('esc-1')
    expect(mockAppCall.ringOwnerApp).not.toHaveBeenCalled()
  })

  it('abroad (toggle ON) → rings the app, no phone ladder', async () => {
    abroadKv(true)
    const res = await call_me_in_app.handler({ purpose: 'দরকারি কথা' })
    expect(res.success).toBe(true)
    expect((res.data as { status?: string }).status).toBe('ringing')
    expect(mockAppCall.ringOwnerApp).toHaveBeenCalled()
    expect(mockLadder.queueCallEscalation).not.toHaveBeenCalled()
  })

  it('in BD but boss explicitly asked for the app → app rings', async () => {
    abroadKv(false)
    const res = await call_me_in_app.handler({ purpose: 'দরকারি কথা', explicitApp: true })
    expect(res.success).toBe(true)
    expect((res.data as { status?: string }).status).toBe('ringing')
    expect(mockAppCall.ringOwnerApp).toHaveBeenCalled()
    expect(mockLadder.queueCallEscalation).not.toHaveBeenCalled()
  })

  it('in BD with a call already running → no second ladder', async () => {
    abroadKv(false)
    mockPrisma.agentCallEscalation.findFirst.mockResolvedValue({ id: 'esc-live' })
    const res = await call_me_in_app.handler({ purpose: 'দরকারি কথা' })
    expect(res.success).toBe(true)
    expect((res.data as { status?: string }).status).toBe('already_calling')
    expect(mockLadder.queueCallEscalation).not.toHaveBeenCalled()
    expect(mockAppCall.ringOwnerApp).not.toHaveBeenCalled()
    // Only ACTIVELY dialing rows block — a report callback queued for later
    // ("৫ মিনিট পরে জানাবে") must not swallow an immediate ask.
    expect(mockPrisma.agentCallEscalation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['app_ringing', 'wa_calling', 'pstn_calling'] } }),
      }),
    )
  })
})

describe('call_me_in_app — duplicate-slot tiebreak (raced executions)', () => {
  it('a rival row created earlier wins — our row cancels itself before dialing', async () => {
    abroadKv(false)
    // pre-check clean, but the post-create rival check finds an older row
    mockPrisma.agentCallEscalation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'esc-older' })
    const res = await call_me_in_app.handler({ purpose: 'দরকারি কথা' })
    expect(res.success).toBe(true)
    expect((res.data as { status?: string }).status).toBe('already_calling')
    expect(mockLadder.startEscalationLadder).not.toHaveBeenCalled()
    expect(mockPrisma.agentCallEscalation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'esc-1' },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    )
  })
})

describe('call_me_in_app — busy defer reported honestly', () => {
  it('deferred_busy → says queued, not ringing', async () => {
    abroadKv(false)
    mockLadder.startEscalationLadder.mockResolvedValue({ ok: true, stage: 'deferred_busy' })
    const res = await call_me_in_app.handler({ purpose: 'দরকারি কথা' })
    expect(res.success).toBe(true)
    expect((res.data as { status?: string }).status).toBe('queued_busy')
  })
})
