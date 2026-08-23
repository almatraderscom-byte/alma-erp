import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from '@/agent/lib/models/__tests__/fixtures/provider-protocol-d00c.json'

/**
 * runOwnerTurn provider-fallback integration for production incident d00c.
 *
 * The exact recorded OpenRouter/DeepSeek response is replayed through the real
 * adapters and the canonical normalizer — only the provider SDK sockets are
 * substituted. Everything else (head routing, the quarantine matrix, the
 * pinned-head policy, persistence) is the production code path.
 *
 * Asserted here:
 *   - a quarantined AUTO binding never reaches the failed provider at all;
 *   - a runtime protocol failure crosses to a DIFFERENT provider and answers;
 *   - nothing from the failed provider — prose or tool call — is persisted;
 *   - an EXPLICIT owner pin fails closed instead of switching silently.
 */

const IDS = vi.hoisted(() => ({
  conversationId: 'conv-d00c',
  turnId: 'turn-d00c',
  ownerMessageId: 'owner-msg-d00c',
  ownerText: 'aaj koto taka bikri holo',
}))
const CONVERSATION_ID = IDS.conversationId
const TURN_ID = IDS.turnId
const OWNER_MESSAGE_ID = IDS.ownerMessageId
const OWNER_TEXT = IDS.ownerText
const INCIDENT = fixture.incident

const store = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  toolCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/prisma', () => {
  const ownerRow = () => store.messages.find((row) => row.id === IDS.ownerMessageId) ?? null
  const turnRow = {
    id: IDS.turnId,
    conversationId: IDS.conversationId,
    status: 'running',
    cancelRequested: false,
    startedAt: new Date('2026-08-23T00:00:00.000Z'),
    userMessageId: IDS.ownerMessageId,
    instructionOrigin: null,
  }
  // Exact-identity reads resolve; "any OTHER row" probes (competing turns,
  // superseding owner input) correctly find nothing.
  const byId = (name: string, where: { id?: unknown } | undefined) => {
    const id = where?.id
    if (name === 'agentTurn' && id === IDS.turnId) return turnRow
    if (name === 'agentMessage' && id === IDS.ownerMessageId) return ownerRow()
    return null
  }
  const table = (name: string) => ({
    findMany: vi.fn(async () => (name === 'agentMessage' ? [...store.messages] : [])),
     
    findFirst: vi.fn(async (args: any = {}) => byId(name, args?.where)),
     
    findUnique: vi.fn(async (args: any = {}) => byId(name, args?.where)),
    count: vi.fn(async () => 0),
    aggregate: vi.fn(async () => ({ _sum: {}, _count: 0 })),
    groupBy: vi.fn(async () => []),
     
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `${name}-${store.messages.length + 1}`, ...data }
      if (name === 'agentMessage') store.messages.push(row)
      return row
    }),
     
    createMany: vi.fn(async ({ data }: any) => {
      if (name === 'agentToolCall') store.toolCalls.push(...data)
      return { count: Array.isArray(data) ? data.length : 0 }
    }),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  })
  const cache = new Map<string | symbol, ReturnType<typeof table>>()
   
  const prisma: any = new Proxy({}, {
    get(_target, prop) {
      if (prop === '$transaction') {
         
        return async (arg: any) => (typeof arg === 'function' ? arg(prisma) : [])
      }
      if (typeof prop === 'string' && prop.startsWith('$')) return async () => []
      if (prop === 'then') return undefined
      if (!cache.has(prop)) cache.set(prop, table(String(prop)))
      return cache.get(prop)
    },
  })
  return { prisma, default: prisma }
})

/** Programmable provider sockets: one scripted response per provider call. */
const sockets = vi.hoisted(() => ({
  openaiQueue: [] as unknown[][],
  openaiCalls: [] as Array<Record<string, unknown>>,
  googleQueue: [] as string[],
  googleCalls: [] as string[],
}))

vi.mock('openai', () => {
  class OpenAI {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          sockets.openaiCalls.push(params)
          const chunks = sockets.openaiQueue.shift() ?? []
          return (async function* () { for (const chunk of chunks) yield chunk })()
        },
      },
    }
    responses = { create: async () => { throw new Error('responses API disabled in this test') } }
  }
  return { default: OpenAI }
})

vi.mock('@google/generative-ai', () => {
  class GoogleGenerativeAI {
    getGenerativeModel(params: { model?: string }) {
      return {
        generateContentStream: async () => {
          sockets.googleCalls.push(params.model ?? 'unknown')
          const text = sockets.googleQueue.shift() ?? 'Boss, আজকের বিক্রি ১২,৫০০ টাকা।'
          return {
            stream: (async function* () {
              yield { candidates: [{ content: { parts: [{ text }] } }] }
            })(),
            response: Promise.resolve({
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6 },
            }),
          }
        },
      }
    }
  }
  return { GoogleGenerativeAI }
})

import { runOwnerTurn } from '@/agent/lib/models/run-owner-turn'
import { getModel } from '@/agent/lib/models/registry'

type Event = Record<string, unknown> & { type: string }

const dsmlChunks = () => [
  ...INCIDENT.chunks.map((content) => ({
    id: 'chatcmpl-d00c',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })),
  { id: 'chatcmpl-d00c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
]

async function runTurn(options: Record<string, unknown> = {}): Promise<Event[]> {
  const events: Event[] = []
  for await (const event of runOwnerTurn(CONVERSATION_ID, {
    turnId: TURN_ID,
    turnOwnerInput: {
      state: 'bound',
      messageId: OWNER_MESSAGE_ID,
      createdAt: new Date('2026-08-23T00:00:00.000Z'),
      text: OWNER_TEXT,
      askCardId: null,
    },
    continuationBinding: { state: 'absent' },
    ...options,
     
  } as any)) events.push(event as Event)
  return events
}

const allText = (events: Event[]) => JSON.stringify(events)

beforeEach(() => {
  store.messages = [{
    id: OWNER_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    role: 'user',
    content: [{ type: 'text', text: OWNER_TEXT }],
    createdAt: new Date('2026-08-23T00:00:00.000Z'),
    usage: {},
  }]
  store.toolCalls = []
  sockets.openaiQueue = []
  sockets.openaiCalls = []
  sockets.googleQueue = []
  sockets.googleCalls = []
  process.env.OPENROUTER_API_KEY = 'test-key-not-a-secret'
  process.env.OPENAI_API_KEY = 'test-key-not-a-secret'
  process.env.GEMINI_API_KEY = 'test-key-not-a-secret'
  delete process.env.HEAVY_HEAD_MODEL_ID
})

describe('quarantined AUTO binding', () => {
  it('never sends a single byte to the quarantined provider', async () => {
    // Auto routing picks the cheap DeepSeek head for a routine question; the
    // recorded quarantine moves it to another provider BEFORE the adapter runs.
    sockets.openaiQueue = [[
      { choices: [{ index: 0, delta: { content: 'Boss, আজকের বিক্রি ১২,৫০০ টাকা।' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]]
    const events = await runTurn()

    const modelInfo = events.find((event) => event.type === 'model_info')
    expect(modelInfo).toBeDefined()
    expect(String(modelInfo!.via)).toContain('protocol_conformance_fallback')
    expect(modelInfo!.modelId).not.toBe('or-deepseek-v4-flash')
    expect(getModel(String(modelInfo!.modelId)).provider)
      .not.toBe(getModel('or-deepseek-v4-flash').provider)

    // Provider traffic happened, and not one request went to the quarantined
    // binding — the switch is decided before the adapter is even constructed.
    expect(sockets.openaiCalls.length).toBeGreaterThan(0)
    for (const call of sockets.openaiCalls) {
      expect(String(call.model)).not.toContain('deepseek')
    }
    // The owner is told why, in one visible line — never a silent switch.
    expect(allText(events)).toContain('quarantine')
  })
})

describe('runtime protocol failure on the exact d00c bytes', () => {
  it('crosses to a different provider, answers clean, and persists nothing from the failure', async () => {
    // The head that auto routing lands on returns the exact incident content.
    sockets.openaiQueue = [dsmlChunks(), dsmlChunks()]
    sockets.googleQueue = ['Boss, আজকের বিক্রি ১২,৫০০ টাকা।']

    const events = await runTurn()
    const models = events.filter((event) => event.type === 'model_info')
    expect(models.length).toBeGreaterThanOrEqual(2)
    const failedProvider = getModel(String(models[0].modelId)).provider
    const rescueProvider = getModel(String(models.at(-1)!.modelId)).provider
    expect(rescueProvider).not.toBe(failedProvider)
    expect(sockets.googleCalls.length).toBeGreaterThan(0)

    // The owner gets the rescue provider's clean answer …
    expect(allText(events)).toContain('আজকের বিক্রি')
    // … and no layer ever saw the machine syntax or its tool arguments.
    expect(allText(events)).not.toContain('DSML')
    expect(allText(events)).not.toContain('smart-murda-moshari')
    expect(events.filter((event) => event.type === 'tool_start')).toEqual([])
    expect(events.filter((event) => event.type === 'tool_input')).toEqual([])

    // Nothing from the failed provider was persisted: no tool-call rows, and no
    // assistant row carrying its content.
    expect(store.toolCalls).toEqual([])
    const persisted = JSON.stringify(store.messages)
    expect(persisted).not.toContain('DSML')
    expect(persisted).not.toContain('smart-murda-moshari')
  })
})

describe('explicit owner pin', () => {
  it('fails closed on the pinned model instead of switching provider', async () => {
    sockets.openaiQueue = [dsmlChunks(), dsmlChunks(), dsmlChunks()]
    sockets.googleQueue = ['this rescue must never be reached']

    const events = await runTurn({ modelId: 'or-deepseek-v4-flash' })

    // Every provider request stayed on the owner's pinned binding …
    expect(sockets.openaiCalls.length).toBeGreaterThan(0)
    for (const call of sockets.openaiCalls) {
      expect(String(call.model)).toContain('deepseek')
    }
    // … and no other provider was touched.
    expect(sockets.googleCalls).toEqual([])
    expect(events.filter((event) => event.type === 'model_info').every(
      (event) => event.modelId === 'or-deepseek-v4-flash',
    )).toBe(true)

    // The owner is told the pinned model is down, not handed a silent switch.
    const text = allText(events)
    expect(text).toContain('পিন করা')
    expect(text).not.toContain('DSML')
    expect(text).not.toContain('smart-murda-moshari')
    expect(events.filter((event) => event.type === 'tool_start')).toEqual([])
    expect(store.toolCalls).toEqual([])
  })
})
