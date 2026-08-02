/**
 * P1-10 / audit §C.6 — the false-success path.
 *
 * On the owner's own checklist run the head asked for a shell `screencapture`,
 * the tool ABSORBED it into a real screenshot, and the result came back
 * `success: true` with a link. Nothing in that result said what had NOT
 * happened, so the head told Boss the file was "saved to Desktop" — about a
 * file that was never written.
 *
 * A result that reports only what went right is an invitation to narrate the
 * rest. This locks the negatives into the payload, in the words the head will
 * be quoting back to him.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const enqueueCommand = vi.fn(async () => ({ id: 'cmd-1' }))
const awaitResult = vi.fn(async () => ({ status: 'done', timedOut: false, stdout: 'data:image/jpeg;base64,AAA' }))
const shareScreenshot = vi.fn(async () => ({ ok: true, imageUrl: '/api/assistant/files?path=x', instruction: 'দেখুন' }))

vi.mock('@/agent/lib/mac-agent/bus', () => ({
  enqueueCommand,
  awaitResult,
  isMacAgentEnabled: async () => true,
  activeDevice: async () => ({ id: 'd1', name: 'Mac', online: true, pairedAt: new Date(), meta: null }),
  listDevices: async () => [{ id: 'd1', name: 'Mac', online: true, pairedAt: new Date(), meta: null }],
  UI_SERVER_IDLE_SENTINEL: 9999,
}))
// Only the upload is faked — the intent classifier is the real one, because
// WHICH commands get absorbed is exactly what must not drift here.
vi.mock('@/agent/lib/mac-agent/screenshot-share', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/lib/mac-agent/screenshot-share')>()),
  shareScreenshot,
}))

describe('screencapture absorbed into a screenshot', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('states plainly that the command did NOT run and no file was saved', async () => {
    const { MAC_TOOLS } = await import('@/agent/tools/mac-tools')
    const runCmd = MAC_TOOLS.find((t) => t.name === 'run_mac_command')
    expect(runCmd).toBeTruthy()
    const res = await runCmd!.handler({
      // A SIMPLE screencapture is what gets absorbed; a compound one (&&,
      // quotes) takes the deterministic refuse path, which was already honest.
      command: 'screencapture ~/Desktop/shot.png',
    })
    const data = (res.data ?? {}) as Record<string, unknown>
    // The success flag is honest — a screenshot really was produced and shown.
    expect(res.success).toBe(true)
    expect(data.redirected).toBe('screenshot')
    // …and the negatives are explicit, which is the part that was missing.
    expect(data.commandRan).toBe(false)
    expect(data.fileSaved).toBe(false)
    expect(String(data.whatHappenedBn)).toContain('চালানো হয়নি')
    expect(String(data.whatHappenedBn)).toContain('সেভ হয়নি')
    // The link still goes back — the owner gets the right result regardless.
    expect(data.imageUrl).toBeTruthy()
  })
})
