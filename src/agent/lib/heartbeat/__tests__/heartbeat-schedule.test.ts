import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HEARTBEAT_CRON, nextHeartbeatCheckAt } from '../heartbeat-schedule'

describe('heartbeat schedule', () => {
  it('stays in sync with the deployed Vercel cron', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>
    }
    const row = vercel.crons.find((cron) => cron.path === '/api/assistant/internal/heartbeat-brain')
    expect(row?.schedule).toBe(HEARTBEAT_CRON)
  })

  it('returns the next future check across the day boundary', () => {
    expect(nextHeartbeatCheckAt(new Date('2026-07-16T05:15:00.000Z')).toISOString())
      .toBe('2026-07-16T07:00:00.000Z')
    expect(nextHeartbeatCheckAt(new Date('2026-07-16T13:00:00.000Z')).toISOString())
      .toBe('2026-07-17T04:00:00.000Z')
  })
})
