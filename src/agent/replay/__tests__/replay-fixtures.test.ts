import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateReplayCase, type ReplayCase } from '../replay-case'

const FIXTURES_DIR = join(__dirname, '..', 'fixtures')

describe('replay fixtures (Roadmap Phase 0 — AGENT-EVAL-001)', () => {
  // rc-*.json only — autonomy-*.json cases (Phase 51) have their own schema and
  // are validated by src/agent/lib/__tests__/autonomy-readiness.test.ts.
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.startsWith('rc-') && f.endsWith('.json'))

  it('has at least one fixture', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s parses and passes format validation', (file) => {
    const parsed = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as ReplayCase
    const errors = validateReplayCase(parsed)
    expect(errors).toEqual([])
    // Filename must match the case id so grep/incident links never drift.
    expect(file).toBe(`${parsed.id}.json`)
  })

  it('case ids are unique', () => {
    const ids = files.map((f) => (JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as ReplayCase).id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
