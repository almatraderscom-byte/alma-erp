import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest'

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? ''
const postgresDescribe = testDatabaseUrl ? describe : describe.skip

function prismaErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : null
}

function twoPartyBarrier(): () => Promise<void> {
  let arrivals = 0
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return async () => {
    arrivals += 1
    if (arrivals === 2) release()
    await ready
  }
}

postgresDescribe('Lifecycle PostgreSQL concurrency gate (SKIPPED without TEST_DATABASE_URL)', () => {
  const prefix = `test:lifecycle:concurrency:${randomUUID()}`
  let first: PrismaClient
  let second: PrismaClient

  beforeAll(async () => {
    if (
      process.env.DATABASE_URL
      && testDatabaseUrl === process.env.DATABASE_URL.trim()
    ) {
      throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL')
    }
    first = new PrismaClient({ datasourceUrl: testDatabaseUrl })
    second = new PrismaClient({ datasourceUrl: testDatabaseUrl })
    await first.$connect()
    await second.$connect()
  })

  afterAll(async () => {
    if (!first || !second) return
    await first.agentKvSetting.deleteMany({ where: { key: { startsWith: prefix } } })
    await Promise.all([first.$disconnect(), second.$disconnect()])
  })

  it('returns the unique idempotency winner and exposes the loser as P2002', async () => {
    const key = `${prefix}:idempotency`
    const value = JSON.stringify({ requestFingerprint: 'a'.repeat(64), outcome: 'winner' })
    const results = await Promise.allSettled([
      first.agentKvSetting.create({ data: { key, value } }),
      second.agentKvSetting.create({ data: { key, value } }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') {
      expect(prismaErrorCode(rejected.reason)).toBe('P2002')
    }
    await expect(first.agentKvSetting.findUnique({ where: { key } })).resolves.toMatchObject({
      key,
      value,
    })
  })

  it('surfaces a real Serializable write-skew race as Prisma P2034', async () => {
    const leftKey = `${prefix}:serializable:left`
    const rightKey = `${prefix}:serializable:right`
    await first.agentKvSetting.createMany({
      data: [
        { key: leftKey, value: 'open' },
        { key: rightKey, value: 'open' },
      ],
    })
    const barrier = twoPartyBarrier()
    const run = (client: PrismaClient, ownKey: string) => client.$transaction(
      async (tx) => {
        const snapshot = await tx.agentKvSetting.findMany({
          where: { key: { in: [leftKey, rightKey] } },
          orderBy: { key: 'asc' },
        })
        expect(snapshot.map((row) => row.value)).toEqual(['open', 'open'])
        await barrier()
        await tx.agentKvSetting.update({
          where: { key: ownKey },
          data: { value: 'claimed' },
        })
      },
      { isolationLevel: 'Serializable' },
    )
    const results = await Promise.allSettled([
      run(first, leftKey),
      run(second, rightKey),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') {
      expect(prismaErrorCode(rejected.reason)).toBe('P2034')
    }
  })
})
