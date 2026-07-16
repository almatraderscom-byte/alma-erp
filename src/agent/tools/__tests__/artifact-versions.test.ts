/**
 * Version history contract (Claude-app parity 2026-07-16): a same-title save
 * must snapshot the OLD body into agent_artifact_versions before overwriting —
 * that snapshot is what the panel's version strip reads. A raced/replayed save
 * of the same version must not crash (upsert, not create).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface ArtifactRow {
  id: string
  conversationId: string
  title: string | null
  type: string | null
  content: string | null
  version: number
  createdAt: Date
}
interface VersionRow {
  artifactId: string
  version: number
  title: string | null
  type: string | null
  content: string | null
}

const artifacts: ArtifactRow[] = []
const versions: VersionRow[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    agentArtifact: {
      findFirst: vi.fn(async ({ where }: { where: { conversationId: string; title: string } }) =>
        artifacts
          .filter((a) => a.conversationId === where.conversationId && a.title === where.title)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ArtifactRow> }) => {
        const row = artifacts.find((a) => a.id === where.id)!
        Object.assign(row, data)
        return row
      }),
      create: vi.fn(async ({ data }: { data: Omit<ArtifactRow, 'id' | 'createdAt'> }) => {
        const row = { ...data, id: `art-${artifacts.length + 1}`, createdAt: new Date() }
        artifacts.push(row)
        return row
      }),
    },
    agentArtifactVersion: {
      upsert: vi.fn(async ({ where, create }: { where: { artifactId_version: { artifactId: string; version: number } }; create: VersionRow }) => {
        const key = where.artifactId_version
        const existing = versions.find((v) => v.artifactId === key.artifactId && v.version === key.version)
        if (existing) return existing
        versions.push(create)
        return create
      }),
    },
  },
}))

import { saveConversationArtifact } from '@/agent/tools/artifact-tools'

beforeEach(() => {
  artifacts.length = 0
  versions.length = 0
  vi.clearAllMocks()
})

describe('saveConversationArtifact version history', () => {
  it('first save creates v1, no snapshot', async () => {
    const r = await saveConversationArtifact({ conversationId: 'c1', title: 'রিপোর্ট', content: 'body-1' })
    expect(r.version).toBe(1)
    expect(versions).toHaveLength(0)
  })

  it('same-title save snapshots the old body then bumps', async () => {
    await saveConversationArtifact({ conversationId: 'c1', title: 'রিপোর্ট', content: 'body-1' })
    const r2 = await saveConversationArtifact({ conversationId: 'c1', title: 'রিপোর্ট', content: 'body-2' })
    expect(r2.version).toBe(2)
    expect(versions).toEqual([expect.objectContaining({ version: 1, content: 'body-1' })])
    expect(artifacts[0].content).toBe('body-2')

    const r3 = await saveConversationArtifact({ conversationId: 'c1', title: 'রিপোর্ট', content: 'body-3' })
    expect(r3.version).toBe(3)
    expect(versions.map((v) => v.version)).toEqual([1, 2])
  })

  it('replayed snapshot of an existing version does not throw or duplicate', async () => {
    await saveConversationArtifact({ conversationId: 'c1', title: 'রিপোর্ট', content: 'body-1' })
    versions.push({ artifactId: artifacts[0].id, version: 1, title: 'রিপোর্ট', type: 'markdown', content: 'body-1' })
    await expect(
      saveConversationArtifact({ conversationId: 'c1', title: 'রিপোর্ট', content: 'body-2' }),
    ).resolves.toMatchObject({ version: 2 })
    expect(versions.filter((v) => v.version === 1)).toHaveLength(1)
  })

  it('different conversations never share history', async () => {
    await saveConversationArtifact({ conversationId: 'c1', title: 'রিপোর্ট', content: 'a' })
    await saveConversationArtifact({ conversationId: 'c2', title: 'রিপোর্ট', content: 'b' })
    expect(artifacts).toHaveLength(2)
    expect(versions).toHaveLength(0)
  })
})
