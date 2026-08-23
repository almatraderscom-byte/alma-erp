import { describe, expect, it } from 'vitest'
import {
  clearPendingOpenTaskContinuation,
  loadPendingOpenTaskContinuation,
  parseOpenTaskContinuation,
  savePendingOpenTaskContinuation,
} from '../AgentOpenTasksChip'

describe('open-task continuation client contract', () => {
  it('accepts only an exact attachable server turn descriptor', () => {
    expect(parseOpenTaskContinuation({
      ok: true,
      action: 'continue',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      lastSeq: -1,
      status: 'running',
      resumeNote: 'must be ignored',
    }, 'conversation-1', 'open-task-1')).toEqual({
      openTaskId: 'open-task-1',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      lastSeq: -1,
      status: 'running',
    })
  })

  it('rejects a legacy raw-note response and a mismatched conversation', () => {
    expect(parseOpenTaskContinuation({
      ok: true,
      action: 'continue',
      resumeNote: 'legacy owner text',
    }, 'conversation-1', 'open-task-1')).toBeNull()
    expect(parseOpenTaskContinuation({
      ok: true,
      action: 'continue',
      conversationId: 'conversation-newer',
      turnId: 'turn-newer',
      lastSeq: -1,
      status: 'running',
    }, 'conversation-1', 'open-task-1')).toBeNull()
    expect(parseOpenTaskContinuation({
      ok: true,
      action: 'continue',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      lastSeq: -2,
      status: 'queued',
    }, 'conversation-1', 'open-task-1')).toBeNull()
    expect(parseOpenTaskContinuation({
      ok: true,
      action: 'continue',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      lastSeq: 214,
      status: 'running',
    }, 'conversation-1', 'open-task-1')).toBeNull()
  })

  it('persists the source id before POST so a lost response can retry after cold load', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const pending = { openTaskId: 'open-task-1', conversationId: 'conversation-1' }

    savePendingOpenTaskContinuation(storage, pending)
    expect(loadPendingOpenTaskContinuation(storage)).toEqual(pending)
    clearPendingOpenTaskContinuation(storage, 'open-task-newer')
    expect(loadPendingOpenTaskContinuation(storage)).toEqual(pending)
    clearPendingOpenTaskContinuation(storage, 'open-task-1')
    expect(loadPendingOpenTaskContinuation(storage)).toBeNull()
  })
})
