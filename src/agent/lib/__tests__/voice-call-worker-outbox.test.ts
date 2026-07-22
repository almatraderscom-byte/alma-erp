import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('voice-call worker report outbox', () => {
  it('persists before delivery, retries non-2xx, and deletes only after success', async () => {
    const mod = await import('../../../../worker/src/voice-call-report-outbox.mjs')
    const dir = await mkdtemp(join(tmpdir(), 'alma-call-report-'))
    dirs.push(dir)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const payload = { callRecordId: 'call-1', transcript: [], status: 'no_answer' }

    const result = await mod.queueAndDeliverCallReport(payload, {
      dir,
      appUrl: 'https://example.test',
      token: 'test-token',
      fetchImpl,
      sleep: async () => {},
      attempts: 2,
    })

    expect(result.ok).toBe(true)
    expect(result.attempt).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps the report on disk when every attempt fails', async () => {
    const mod = await import('../../../../worker/src/voice-call-report-outbox.mjs')
    const dir = await mkdtemp(join(tmpdir(), 'alma-call-report-'))
    dirs.push(dir)
    const fetchImpl = vi.fn().mockResolvedValue(new Response('down', { status: 503 }))
    await expect(mod.queueAndDeliverCallReport(
      { callRecordId: 'call-2', transcript: [], status: 'no_answer' },
      { dir, appUrl: 'https://example.test', token: 'test-token', fetchImpl, sleep: async () => {}, attempts: 2 },
    )).rejects.toThrow(/HTTP 503/)
    expect(await readdir(dir)).toEqual(['call-2.json'])
  })
})
