/**
 * Boss's message must be the last thing the model reads.
 *
 * From his screenshot: asked a hard benchmark question, and the agent's whole
 * visible reasoning was about `[INTERNAL CONTROL — this is NOT a new Boss
 * message]` — because that banner, appended after his message, WAS the newest
 * input. A model orients on the newest input; the newest input told it to ignore
 * the newest input.
 */
import { describe, expect, it } from 'vitest'
import { insertControlNote } from '@/agent/lib/control-note-order'

const boss = { role: 'user', content: 'ajker sale koto?' }
const reply = { role: 'assistant', content: 'বস, …' }
const note = (n: string) => ({ role: 'user', content: `[INTERNAL CONTROL] ${n}` })

const lastUser = (ms: Array<{ role: string; content: string }>) =>
  [...ms].reverse().find((m) => m.role === 'user')!.content

describe('ordering', () => {
  it('puts the note BEFORE his message, so his stays the freshest input', () => {
    const out = insertControlNote([reply, boss], note('card state'))
    expect(lastUser(out)).toBe('ajker sale koto?')
  })

  it('keeps his message last however many notes pile up', () => {
    let ms = [reply, boss]
    ms = insertControlNote(ms, note('card state'))
    ms = insertControlNote(ms, note('permission mode'))
    ms = insertControlNote(ms, note('correction'))
    expect(lastUser(ms)).toBe('ajker sale koto?')
    // …and the notes keep the order they were added in.
    expect(ms.map((m) => m.content)).toEqual([
      'বস, …',
      '[INTERNAL CONTROL] card state',
      '[INTERNAL CONTROL] permission mode',
      '[INTERNAL CONTROL] correction',
      'ajker sale koto?',
    ])
  })

  it('loses nothing — every message survives', () => {
    const out = insertControlNote([reply, boss], note('x'))
    expect(out).toHaveLength(3)
    expect(out).toEqual(expect.arrayContaining([reply, boss]))
  })

  it('appends when there is no user message at all — a tool-only continuation', () => {
    // Dropping the note would be worse than ordering it imperfectly.
    const out = insertControlNote([reply], note('x'))
    expect(out[out.length - 1].content).toContain('INTERNAL CONTROL')
  })

  it('inserts before HIS message, not before an earlier one', () => {
    const older = { role: 'user', content: 'purono proshno' }
    const out = insertControlNote([older, reply, boss], note('x'))
    expect(out.map((m) => m.content)).toEqual([
      'purono proshno',
      'বস, …',
      '[INTERNAL CONTROL] x',
      'ajker sale koto?',
    ])
  })
})
