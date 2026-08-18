import { describe, it, expect, vi, beforeAll } from 'vitest'

beforeAll(() => { vi.stubEnv('AGENT_PLAN_GATE', 'on') })

describe('plan-first classification (owner ask: plan like Claude Code)', () => {
  const derive = async (t: string) => {
    const req = await import('@/agent/lib/owner-turn-requirements')
    return req.deriveOwnerTurnRequirements(t).planFirst
  }

  it('plans multi-step work stated with one sequence marker', async () => {
    expect(await derive('অর্ডার গুলো প্যাক করে তারপর কুরিয়ারে দাও')).toBe(true)
  })

  it('plans work naming two different subjects', async () => {
    expect(await derive('স্টক দেখে অর্ডার গুলো আপডেট করে দাও')).toBe(true)
  })

  it('plans a long instruction', async () => {
    expect(await derive('আজকের সব অর্ডার একবার দেখে নাও, যেগুলোর ট্র্যাকিং নেই সেগুলো আলাদা করে রাখো এবং কাস্টমারদের একটা করে মেসেজ পাঠিয়ে দাও')).toBe(true)
  })

  it('does NOT plan a plain lookup question', async () => {
    expect(await derive('আজকে কত অর্ডার হয়েছে?')).toBe(false)
  })

  it('does NOT plan a question that merely carries an action verb', async () => {
    expect(await derive('কেন পেজটা খুলতে পারছি না?')).toBe(false)
  })

  it('does NOT plan a single one-move command', async () => {
    expect(await derive('নামাজ মার্ক করে দাও')).toBe(false)
  })
})
