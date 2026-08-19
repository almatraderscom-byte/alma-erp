import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  approvalConversationId,
  approvalExecutionTurnId,
  progressTurnIdFromApprovalPayload,
  withApprovalProgressTurn,
} from '../approval-progress-context'

describe('approval execution activity binding', () => {
  it('rebinds approved work to the running progress turn', () => {
    expect(approvalExecutionTurnId('turn-progress', 'turn-terminal'))
      .toBe('turn-progress')
  })

  it('keeps the staged turn only when progress presence was unavailable', () => {
    expect(approvalExecutionTurnId(null, 'turn-staged')).toBe('turn-staged')
    expect(approvalExecutionTurnId(null, null)).toBeNull()
  })

  it('persists a sync approval progress id without mutating its staged tool input', () => {
    const toolInput = { action: 'click', selector: '#confirm', amount: 42 }
    const original = { conversationId: 'conversation-1', toolInput, sourceTurnId: 'source-turn' }
    const persisted = withApprovalProgressTurn(original, ' progress-turn ')

    expect(persisted).toMatchObject({
      conversationId: 'conversation-1',
      progressTurnId: 'progress-turn',
      sourceTurnId: 'source-turn',
    })
    expect(persisted.toolInput).toBe(toolInput)
    expect(toolInput).toEqual({ action: 'click', selector: '#confirm', amount: 42 })
    expect(original).not.toHaveProperty('progressTurnId')
    expect(progressTurnIdFromApprovalPayload(persisted)).toBe('progress-turn')
    expect(approvalConversationId({ payload: persisted })).toBe('conversation-1')
  })

  it('binds the generic AIOS executor to progress while preserving source approval metadata', () => {
    const route = readFileSync(join(
      process.cwd(),
      'src/app/api/assistant/actions/[id]/approve/route.ts',
    ), 'utf8')
    expect(route).toContain(
      'const executionTurnId = approvalExecutionTurnId(options.progressTurnId, sourceTurnId)',
    )
    expect(route).toMatch(/const result = await executeTool[\s\S]*?turnId: executionTurnId,/)
    expect(route).toMatch(/const approvalEnvelope = signEnvelope[\s\S]*?turnId: sourceTurnId,/)
  })
})
