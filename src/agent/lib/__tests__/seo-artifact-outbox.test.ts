import { beforeEach, describe, expect, it } from 'vitest'
import fixture from './fixtures/seo-artifact-incident.json'
import {
  artifactDeliveryKey,
  assertSeoStorageReceiptsStable,
  buildSeoArtifactMessage,
  enqueueSeoArtifactDeliveryTx,
  findLegacySeoDeliveryMessage,
  runSeoArtifactDeliveryStateMachine,
  seoArtifactOutboxEnabled,
  validateSeoArtifactSource,
  type SeoArtifactCard,
  type SeoArtifactDeliveryBundle,
  type SeoArtifactDeliveryOutbox,
  type SeoArtifactDeliveryPort,
  type SeoArtifactDeliverySource,
} from '@/agent/lib/seo-artifact-outbox'
import { buildAgentPresentationV1 } from '@/agent/lib/presentation/build-presentation'

const NOW = new Date('2026-08-23T04:00:00.000Z')
const KEY = artifactDeliveryKey(fixture.pendingActionId)

function source(): SeoArtifactDeliverySource {
  return {
    actionId: fixture.pendingActionId,
    conversationId: fixture.conversationId,
    status: 'executed',
    summary: 'SEO audit',
    payload: { url: 'https://example.test' },
    result: { artifacts: [`${fixture.storagePrefix}/audit.json`] },
    resolvedAt: NOW,
  }
}

function bundle(): SeoArtifactDeliveryBundle {
  const receipts = [
    ['dashboard', 'report.html', 'text/html', '<!doctype html><title>SEO</title>'],
    ['report', 'report.md', 'text/markdown', '# SEO report'],
    ['issues', 'issues.csv', 'text/csv', 'severity,issue\nhigh,title'],
    ['raw', 'audit.json', 'application/json', '{"score":61}'],
  ].map(([logicalName, filename, mediaType, body]) => ({
    logicalName: logicalName as 'dashboard' | 'report' | 'issues' | 'raw',
    path: `${fixture.storagePrefix}/${filename}`,
    mediaType,
    sha256: `${logicalName}-sha256`,
    bytes: Buffer.byteLength(body),
  }))
  return {
    host: fixture.host,
    title: fixture.title,
    artifactType: 'html',
    artifactContent: '<!doctype html><title>SEO</title>',
    artifactSha256: 'dashboard-sha256',
    artifactStoragePath: `${fixture.storagePrefix}/report.html`,
    summaryBn: fixture.summaryBn,
    receipts,
  }
}

class MemoryPort implements SeoArtifactDeliveryPort {
  outbox: SeoArtifactDeliveryOutbox = {
    id: 'outbox-1',
    deliveryKey: KEY,
    sourceId: fixture.pendingActionId,
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    leaseUntil: null,
  }
  artifacts = new Map<string, SeoArtifactCard & { deliveryKey: string; messageId: string | null }>()
  messages = new Map<string, ReturnType<typeof buildSeoArtifactMessage>>()
  storage = new Map<string, string>()
  ledger = new Set<string>(['enqueued'])
  ledgerPayload = new Map<string, Record<string, unknown>>()
  failOnceAfter: 'storage_persisted' | 'artifact_linked' | 'message_linked' | null = null
  legacyArtifact: (SeoArtifactCard & { content: string; deliveryKey: string | null; messageId: string | null }) | null = null
  legacyMessageId: string | null = null
  mutatePreparedBundle = false

  async load() {
    return { outbox: this.outbox, source: source() }
  }

  async claim(_actionId: string, leaseOwner: string, leaseUntil: Date) {
    if (this.outbox.status === 'delivered') return null
    this.outbox.status = 'processing'
    this.outbox.leaseOwner = leaseOwner
    this.outbox.leaseUntil = leaseUntil
    this.outbox.attempts += 1
    return this.outbox
  }

  async prepareStorage(_source: SeoArtifactDeliverySource, outbox: SeoArtifactDeliveryOutbox) {
    const built = bundle()
    if (this.mutatePreparedBundle) {
      built.receipts = built.receipts.map((receipt) => receipt.logicalName === 'raw'
        ? { ...receipt, sha256: 'mutated-raw-sha256' }
        : receipt)
    }
    assertSeoStorageReceiptsStable(outbox.storageReceipts, built.receipts)
    return built
  }

  private crashAfter(milestone: MemoryPort['failOnceAfter']) {
    this.ledger.add(milestone!)
    if (this.failOnceAfter === milestone) {
      this.failOnceAfter = null
      throw new Error(`crash_after_${milestone}`)
    }
  }

  async persistStorage(_outbox: SeoArtifactDeliveryOutbox, built: SeoArtifactDeliveryBundle) {
    assertSeoStorageReceiptsStable(this.outbox.storageReceipts, built.receipts)
    this.outbox.storageReceipts ??= built.receipts
    for (const receipt of built.receipts) this.storage.set(receipt.path, receipt.sha256)
    this.crashAfter('storage_persisted')
  }

  async upsertArtifact(_outbox: SeoArtifactDeliveryOutbox, built: SeoArtifactDeliveryBundle) {
    const existing = this.artifacts.get(KEY)
    if (existing) return existing
    const adopted = this.legacyArtifact && this.legacyArtifact.content === built.artifactContent
      ? { ...this.legacyArtifact, deliveryKey: KEY }
      : { id: 'artifact-new', title: built.title, type: built.artifactType, version: 1, deliveryKey: KEY, messageId: null }
    this.artifacts.set(KEY, adopted)
    this.ledgerPayload.set('artifact_linked', {
      artifactId: adopted.id,
      title: adopted.title,
      type: adopted.type,
    })
    this.crashAfter('artifact_linked')
    return adopted
  }

  async upsertMessage(
    _outbox: SeoArtifactDeliveryOutbox,
    built: SeoArtifactDeliveryBundle,
    artifact: SeoArtifactCard,
  ) {
    const existing = this.messages.get(KEY)
    if (existing) return { id: existing.id }
    const id = this.legacyMessageId ?? 'message-new'
    const message = buildSeoArtifactMessage({
      messageId: id,
      deliveryKey: KEY,
      outboxId: this.outbox.id,
      artifact,
      bundle: built,
    })
    this.messages.set(KEY, message)
    const linked = this.artifacts.get(KEY)!
    linked.messageId = id
    this.crashAfter('message_linked')
    return { id }
  }

  async complete() {
    this.outbox.status = 'delivered'
    this.outbox.leaseUntil = null
    this.outbox.leaseOwner = null
    this.ledger.add('delivered')
    const artifact = this.artifacts.get(KEY)!
    this.ledger.add('artifact_saved')
    this.ledgerPayload.set('artifact_saved', {
      artifactId: artifact.id,
      title: artifact.title,
      type: artifact.type,
      messageId: this.messages.get(KEY)?.id,
    })
    this.ledgerPayload.set('delivered', {
      artifactId: artifact.id,
      title: artifact.title,
      type: artifact.type,
      messageId: this.messages.get(KEY)?.id,
    })
  }

  async fail(_outbox: SeoArtifactDeliveryOutbox, error: Error) {
    this.outbox.status = this.outbox.attempts >= this.outbox.maxAttempts ? 'dead' : 'retry'
    this.outbox.lastError = error.message
    this.outbox.leaseUntil = null
    this.outbox.leaseOwner = null
    this.ledger.add(`attempt_failed:${error.message}`)
    if (this.outbox.status === 'dead') this.ledger.add('dead')
  }
}

let port: MemoryPort

beforeEach(() => {
  port = new MemoryPort()
})

describe('SEO artifact durable outbox', () => {
  it('has one explicit rollback flag while defaulting the new durable path on', () => {
    expect(seoArtifactOutboxEnabled({})).toBe(true)
    expect(seoArtifactOutboxEnabled({ AGENT_ARTIFACT_OUTBOX: 'false' })).toBe(false)
    expect(seoArtifactOutboxEnabled({ AGENT_ARTIFACT_OUTBOX: 'off' })).toBe(false)
  })

  it('converges one storage set, artifact, linked message and milestone ledger after every crash point', async () => {
    for (const crash of ['storage_persisted', 'artifact_linked', 'message_linked'] as const) {
      port = new MemoryPort()
      port.failOnceAfter = crash

      const first = await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, {
        workerId: 'worker-a', now: NOW,
      })
      expect(first.status).toBe('retry')

      const second = await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, {
        workerId: 'worker-b', now: new Date(NOW.getTime() + 60_000),
      })
      expect(second.status).toBe('delivered')
      expect(port.storage.size).toBe(4)
      expect(port.artifacts.size).toBe(1)
      expect(port.messages.size).toBe(1)
      expect(port.artifacts.get(KEY)?.messageId).toBe(port.messages.get(KEY)?.id)
      for (const milestone of ['enqueued', 'storage_persisted', 'artifact_linked', 'message_linked', 'artifact_saved', 'delivered']) {
        expect(port.ledger.has(milestone), milestone).toBe(true)
      }
    }
  })

  it('duplicate delivery callback is a no-op after the first logical delivery', async () => {
    const first = await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, { workerId: 'a', now: NOW })
    const attempts = port.outbox.attempts
    const second = await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, { workerId: 'b', now: NOW })
    expect(first.status).toBe('delivered')
    expect(second).toMatchObject({ status: 'delivered', idempotent: true })
    expect(port.outbox.attempts).toBe(attempts)
    expect(port.artifacts.size).toBe(1)
    expect(port.messages.size).toBe(1)
  })

  it('rejects mutated source bytes after the first receipt set is frozen', async () => {
    port.failOnceAfter = 'storage_persisted'
    const first = await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, { workerId: 'a', now: NOW })
    expect(first.status).toBe('retry')
    const frozen = port.outbox.storageReceipts
    port.mutatePreparedBundle = true
    const retry = await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, { workerId: 'b', now: NOW })
    expect(retry.status).toBe('retry')
    expect(port.outbox.lastError).toBe('seo_artifact_source_mutated_after_receipt')
    expect(port.outbox.storageReceipts).toEqual(frozen)
    expect(port.artifacts.size).toBe(0)
    expect(port.messages.size).toBe(0)
  })

  it('requires the exact action-owned storage prefix and matching audit URL', () => {
    expect(validateSeoArtifactSource(source(), 'https://example.test/')).toMatchObject({
      prefix: fixture.storagePrefix,
      rawPath: `${fixture.storagePrefix}/audit.json`,
    })
    expect(() => validateSeoArtifactSource({
      ...source(),
      result: { artifacts: [`${fixture.storagePrefix}/../other/audit.json`] },
    }, 'https://example.test')).toThrow('seo_artifact_invalid_storage_path')
    expect(() => validateSeoArtifactSource({
      ...source(),
      result: { artifacts: [`${fixture.storagePrefix}/audit.json?download=1`] },
    }, 'https://example.test')).toThrow('seo_artifact_invalid_storage_path')
    expect(() => validateSeoArtifactSource(source(), 'https://other.test')).toThrow('seo_artifact_audit_url_mismatch')
  })

  it('adopts only the exact same-conversation assistant legacy-spine message', () => {
    const built = bundle()
    const canonical = buildSeoArtifactMessage({
      messageId: fixture.legacyMessageId,
      deliveryKey: KEY,
      outboxId: 'outbox-1',
      artifact: { id: fixture.legacyArtifactId, title: fixture.title, type: 'html', version: 1 },
      bundle: built,
    })
    const exact = {
      id: fixture.legacyMessageId,
      conversationId: fixture.conversationId,
      role: 'assistant',
      clientRequestId: null,
      content: canonical.content,
    }
    expect(findLegacySeoDeliveryMessage([exact], built, fixture.conversationId)?.id).toBe(fixture.legacyMessageId)
    expect(findLegacySeoDeliveryMessage([{ ...exact, conversationId: 'other' }], built, fixture.conversationId)).toBeNull()
    expect(findLegacySeoDeliveryMessage([{ ...exact, role: 'user' }], built, fixture.conversationId)).toBeNull()
    expect(findLegacySeoDeliveryMessage([{
      ...exact,
      content: [{ type: 'text', text: `${(canonical.content[0] as { text: string }).text}\nextra` }],
    }], built, fixture.conversationId)).toBeNull()
  })

  it('never retargets an existing outbox to another conversation', async () => {
    const tx = {
      agentArtifactDeliveryOutbox: {
        upsert: async () => ({
          id: 'outbox-1', deliveryKey: KEY, sourceKind: 'pending_action',
          sourceId: fixture.pendingActionId, logicalName: 'seo-dashboard', version: 1,
          conversationId: 'different-conversation',
        }),
      },
      agentArtifactDeliveryLedger: { upsert: async () => ({}) },
    }
    await expect(enqueueSeoArtifactDeliveryTx(tx, {
      actionId: fixture.pendingActionId,
      conversationId: fixture.conversationId,
    })).rejects.toThrow('seo_artifact_conversation_binding_mismatch')
  })

  it('makes the final ordinary failure terminal and observable', async () => {
    port.outbox.attempts = 4
    port.outbox.maxAttempts = 5
    port.failOnceAfter = 'storage_persisted'
    const result = await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, { workerId: 'last', now: NOW })
    expect(result.status).toBe('dead')
    expect(port.outbox.status).toBe('dead')
    expect(port.ledger.has('dead')).toBe(true)
  })

  it('adopts the incident-shaped partial artifact and server-spine message instead of duplicating them', async () => {
    port.legacyArtifact = {
      id: fixture.legacyArtifactId,
      title: fixture.title,
      type: 'html',
      version: 1,
      content: bundle().artifactContent,
      deliveryKey: null,
      messageId: null,
    }
    port.legacyMessageId = fixture.legacyMessageId

    await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, { workerId: 'repair', now: NOW })

    expect(port.artifacts.get(KEY)?.id).toBe(fixture.legacyArtifactId)
    expect(port.artifacts.get(KEY)?.messageId).toBe(fixture.legacyMessageId)
    expect(port.messages.get(KEY)?.id).toBe(fixture.legacyMessageId)
    expect(port.artifacts.size).toBe(1)
    expect(port.messages.size).toBe(1)
  })

  it('persists the canonical timeline file block used by web and iOS cold load', async () => {
    const liveReturn = await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, { workerId: 'a', now: NOW })
    const message = port.messages.get(KEY)!
    const artifact = port.artifacts.get(KEY)!
    // A prose-only presentationV2 would make AgentApp ignore this raw timeline
    // on reload and hide the file. Omitting it keeps one canonical cold path.
    expect(message.usage.presentationV2).toBeUndefined()
    expect(message.usage.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ t: 'file', id: artifact.id, name: artifact.title, kind: artifact.type }),
    ]))
    const projected = buildAgentPresentationV1({
      messageId: message.id,
      content: message.content,
      timeline: message.usage.timeline,
    })
    expect(projected.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'file', artifactId: artifact.id, title: artifact.title, kind: artifact.type }),
    ]))
    expect(message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'file_ref',
        path: `${fixture.storagePrefix}/report.html`,
        artifactId: artifact.id,
      }),
    ]))
    expect(message.usage.artifactSaved).toEqual({
      type: 'artifact_saved',
      id: artifact.id,
      title: artifact.title,
      artifactType: artifact.type,
    })
    expect(liveReturn.artifact).toMatchObject({ id: artifact.id, title: artifact.title, type: artifact.type })
    expect(port.ledgerPayload.get('artifact_linked')).toMatchObject({
      artifactId: artifact.id,
      title: artifact.title,
      type: artifact.type,
    })
    expect(port.ledgerPayload.get('artifact_saved')).toMatchObject({
      artifactId: artifact.id,
      title: artifact.title,
      type: artifact.type,
      messageId: message.id,
    })
  })
})

describe('failure updates are fenced by lease ownership (Codex P2, PR #847)', () => {
  // The fenced branch lives in the Prisma port, whose transaction needs a real
  // database — so the invariant is pinned at the source level, the same way the
  // stream-contract guards pin the reference emit sites.
  it('the prisma port conditions the failure write on processing + leaseOwner', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../seo-artifact-outbox.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async fail(outbox, error, now)')
    expect(start).toBeGreaterThan(0)
    const body = source.slice(start, start + 2400)
    // fenced update: never an unconditional `update({ where: { id } })`
    expect(body).toContain('updateMany')
    expect(body).toContain("status: 'processing'")
    expect(body).toContain('leaseOwner: outbox.leaseOwner')
    // a caller with no lease may record nothing
    expect(body).toContain('if (!outbox.leaseOwner)')
    // and a lost fence is logged, not silently retried
    expect(body).toContain("'stale_failure_ignored'")
    expect(body).not.toMatch(/await tx\.agentArtifactDeliveryOutbox\.update\(\{\s*\n\s*where: \{ id: outbox\.id \},\s*\n\s*data: \{\s*\n\s*status: dead/)
  })
})
