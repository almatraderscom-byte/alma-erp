import { describe, it, expect } from 'vitest'
import {
  createSeqDeduper,
  isTerminalEventType,
  sseFrame,
  turnEventChannel,
} from '@/agent/lib/turn-events'
import { buildTurnJobData } from '@/agent/lib/turn-queue'

/**
 * A2 — VPS handoff for long turns. These lock the two contracts the handoff
 * depends on without needing live Redis/BullMQ:
 *   - the enqueue payload the route hands the worker (buildTurnJobData), and
 *   - the replay+tail ordering the stream endpoint relies on (seq dedup +
 *     terminal detection + wire framing).
 */

describe('A2 — enqueue payload (buildTurnJobData)', () => {
  it('normalizes a valid request into a runnable job payload', () => {
    const data = buildTurnJobData('turn_1', 'conv_1', {
      message: '  দীর্ঘ রিপোর্ট বানাও  ',
      files: [
        { bucket: 'agent-files', path: 'a/b.png', mediaType: 'image/png' },
        // malformed entries are dropped
        { bucket: 'agent-files', path: 123 as unknown as string, mediaType: 'image/png' },
      ],
      projectId: 'proj_9',
      personalMode: true,
      clientRequestId: 'request_123',
    })
    expect(data).toEqual({
      turnId: 'turn_1',
      conversationId: 'conv_1',
      message: 'দীর্ঘ রিপোর্ট বানাও',
      files: [{ bucket: 'agent-files', path: 'a/b.png', mediaType: 'image/png' }],
      projectId: 'proj_9',
      personalMode: true,
      clientRequestId: 'request_123',
    })
  })

  it('refuses to build a job without a turnId, conversation, or message', () => {
    expect(buildTurnJobData(null, 'conv_1', { message: 'hi' })).toBeNull()
    expect(buildTurnJobData('turn_1', null, { message: 'hi' })).toBeNull()
    expect(buildTurnJobData('turn_1', 'conv_1', { message: '   ' })).toBeNull()
  })
})

describe('A2 — replay + live tail ordering', () => {
  it('emits each seq exactly once across an overlapping replay and live tail', () => {
    // Durable replay rows the stream endpoint reads first.
    const replay = [
      { seq: 0, type: 'conversation_id', payload: { type: 'conversation_id', id: 'conv_1' } },
      { seq: 1, type: 'text_delta', payload: { type: 'text_delta', delta: 'হ্যা' } },
    ]
    // Live publishes — note seq 1 overlaps the replay (raced) and must be ignored.
    const live = [
      { seq: 1, type: 'text_delta', payload: { type: 'text_delta', delta: 'হ্যা' } },
      { seq: 2, type: 'text_delta', payload: { type: 'text_delta', delta: 'লো' } },
      { seq: 3, type: 'done', payload: { type: 'done' } },
    ]

    const dedup = createSeqDeduper()
    const emitted: number[] = []
    let terminated = false
    for (const e of replay) if (dedup.accept(e.seq)) emitted.push(e.seq)
    for (const e of live) {
      if (!dedup.accept(e.seq)) continue
      emitted.push(e.seq)
      if (isTerminalEventType(e.type)) terminated = true
    }

    expect(emitted).toEqual([0, 1, 2, 3]) // seq 1 emitted once, no duplicate
    expect(terminated).toBe(true)
  })

  it('detects terminal events and frames payloads as SSE', () => {
    expect(isTerminalEventType('done')).toBe(true)
    expect(isTerminalEventType('error')).toBe(true)
    expect(isTerminalEventType('text_delta')).toBe(false)
    expect(turnEventChannel('turn_42')).toBe('turn:turn_42:events')
    expect(sseFrame({ type: 'text_delta', delta: 'x' })).toBe(
      'data: {"type":"text_delta","delta":"x"}\n\n',
    )
  })
})
