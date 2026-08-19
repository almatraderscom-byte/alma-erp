import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('computer preview migration privacy', () => {
  it('fails closed for every browser and Mac table that can expose owner activity', () => {
    const migration = readFileSync(join(
      process.cwd(),
      'prisma/migrations/20261018000000_live_computer_preview_binding/migration.sql',
    ), 'utf8')
    for (const table of [
      'live_browser_frames',
      'live_browser_preview_leases',
      'mac_agent_devices',
      'mac_agent_commands',
      'mac_agent_session_events',
      'mac_agent_frames',
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      )
    }
  })
})
