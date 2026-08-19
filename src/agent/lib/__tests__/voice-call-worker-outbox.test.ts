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

  it('does not retry permanent 4xx responses and quarantines the report', async () => {
    const mod = await import('../../../../worker/src/voice-call-report-outbox.mjs')
    const dir = await mkdtemp(join(tmpdir(), 'alma-call-report-'))
    dirs.push(dir)
    const fetchImpl = vi.fn().mockResolvedValue(new Response('orphan call', { status: 404 }))

    await expect(mod.queueAndDeliverCallReport(
      { callRecordId: 'call-3', transcript: [], status: 'completed' },
      { dir, appUrl: 'https://example.test', token: 'test-token', fetchImpl, sleep: async () => {}, attempts: 6 },
    )).rejects.toMatchObject({ status: 404, retryable: false, permanent: true })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual(['dead-letter'])
    expect(await readdir(join(dir, 'dead-letter'))).toEqual(['call-3.json'])
  })

  it('does not retry auth failures immediately but keeps them recoverable', async () => {
    const mod = await import('../../../../worker/src/voice-call-report-outbox.mjs')
    const dir = await mkdtemp(join(tmpdir(), 'alma-call-report-'))
    dirs.push(dir)
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad token', { status: 401 }))

    await expect(mod.queueAndDeliverCallReport(
      { callRecordId: 'call-5', transcript: [], status: 'completed' },
      { dir, appUrl: 'https://example.test', token: 'test-token', fetchImpl, sleep: async () => {}, attempts: 6 },
    )).rejects.toMatchObject({ status: 401, retryable: false, permanent: false })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual(['call-5.json'])
  })

  it('shares one in-flight outbox drain', async () => {
    const mod = await import('../../../../worker/src/voice-call-report-outbox.mjs')
    const dir = await mkdtemp(join(tmpdir(), 'alma-call-report-'))
    dirs.push(dir)
    await mod.persistCallReport({ callRecordId: 'call-4', transcript: [], status: 'completed' }, dir)

    let resolveFetch!: (response: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
    const options = { dir, appUrl: 'https://example.test', token: 'test-token', fetchImpl, sleep: async () => {}, attempts: 1 }
    const first = mod.drainCallReportOutbox(options)
    const second = mod.drainCallReportOutbox(options)

    expect(second).toBe(first)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    resolveFetch(new Response('{}', { status: 200 }))
    await expect(first).resolves.toEqual([{ name: 'call-4.json', ok: true, attempt: 1 }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
