import { describe, expect, it } from 'vitest'
import fixture from './fixtures/seo-artifact-incident.json'
import { DEFAULT_AGENT_CONTROLS } from '@/agent/lib/agent-controls'
import {
  EXPLICIT_CHROME_MODALITY_TOOLS,
  hasExplicitChromeModality,
} from '@/agent/lib/live-browser/modality'
import { resolveToolsByName } from '@/agent/tools/find-tool'
import {
  composeTurnToolAllowlist,
  filterFindToolResultForTurn,
  filterTurnToolDefinitions,
} from '@/agent/tools/selection/turn-capability-context'
import {
  artifactDeliveryKey,
  assertSeoStorageReceiptsStable,
  buildSeoArtifactMessage,
  runSeoArtifactDeliveryStateMachine,
  type SeoArtifactCard,
  type SeoArtifactDeliveryBundle,
  type SeoArtifactDeliveryOutbox,
  type SeoArtifactDeliveryPort,
  type SeoArtifactDeliverySource,
} from '@/agent/lib/seo-artifact-outbox'
import { liveArtifactCard } from '@/agent/lib/artifact-card-visibility'
import { buildAgentPresentationV1 } from '@/agent/lib/presentation/build-presentation'

/**
 * The audited SEO+Chrome turn, end to end.
 *
 * In production the owner asked for a deep SEO audit **through his own Chrome**.
 * find_tool located the Chrome quartet, the pinned SEO allowlist refused it, the
 * worker produced an artifact anyway, and nothing linked that artifact to a
 * message — so neither the native card nor a cold web reload could show it.
 *
 * This walks the whole repaired chain in one test:
 *   composition (Chrome modality over the primary SEO skill)
 *     → worker callback (durable delivery state machine)
 *     → durable outbox (storage + artifact + canonical message + receipts)
 *     → native artifact card (file_ref / artifactSaved / no duplicate live card)
 *     → mounted web cold reload (the same message projects the file block).
 */

const OWNER_TEXT =
  'Amr chrome e dhuke amr website er seo shob gulo page er deeply check koro. Amk report daw'
const NOW = new Date('2026-08-23T04:00:00.000Z')
const KEY = artifactDeliveryKey(fixture.pendingActionId)

/** The pinned SEO skill's own allowlist — Chrome is deliberately absent. */
const SEO_SKILL_ALLOWLIST = new Set([
  'find_tool',
  'run_website_seo_audit',
  'check_website_seo_audit',
  'fetch_website_page',
  'get_website_health',
])

function source(): SeoArtifactDeliverySource {
  return {
    actionId: fixture.pendingActionId,
    conversationId: fixture.conversationId,
    status: 'executed',
    summary: 'SEO audit',
    payload: { url: `https://${fixture.host}` },
    result: { artifacts: [`${fixture.storagePrefix}/audit.json`] },
    resolvedAt: NOW,
  }
}

function bundle(): SeoArtifactDeliveryBundle {
  const receipts = ([
    ['dashboard', 'report.html', 'text/html', '<!doctype html><title>SEO</title>'],
    ['report', 'report.md', 'text/markdown', '# SEO report'],
    ['issues', 'issues.csv', 'text/csv', 'severity,issue\nhigh,title'],
    ['raw', 'audit.json', 'application/json', '{"score":61}'],
  ] as const).map(([logicalName, filename, mediaType, body]) => ({
    logicalName,
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

/** In-memory stand-in for the durable tables the worker callback writes. */
class DeliveryPort implements SeoArtifactDeliveryPort {
  outbox: SeoArtifactDeliveryOutbox = {
    id: 'outbox-chrome-seo',
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

  async load() { return { outbox: this.outbox, source: source() } }

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
    assertSeoStorageReceiptsStable(outbox.storageReceipts, built.receipts)
    return built
  }

  async persistStorage(_outbox: SeoArtifactDeliveryOutbox, built: SeoArtifactDeliveryBundle) {
    this.outbox.storageReceipts ??= built.receipts
    for (const receipt of built.receipts) this.storage.set(receipt.path, receipt.sha256)
    this.ledger.add('storage_persisted')
  }

  async upsertArtifact(_outbox: SeoArtifactDeliveryOutbox, built: SeoArtifactDeliveryBundle) {
    const existing = this.artifacts.get(KEY)
    if (existing) return existing
    const created = {
      id: fixture.legacyArtifactId,
      title: built.title,
      type: built.artifactType,
      version: 1,
      deliveryKey: KEY,
      messageId: null as string | null,
    }
    this.artifacts.set(KEY, created)
    this.ledger.add('artifact_linked')
    return created
  }

  async upsertMessage(
    _outbox: SeoArtifactDeliveryOutbox,
    built: SeoArtifactDeliveryBundle,
    artifact: SeoArtifactCard,
  ) {
    const existing = this.messages.get(KEY)
    if (existing) return { id: existing.id }
    const message = buildSeoArtifactMessage({
      messageId: fixture.legacyMessageId,
      deliveryKey: KEY,
      outboxId: this.outbox.id,
      artifact,
      bundle: built,
    })
    this.messages.set(KEY, message)
    this.artifacts.get(KEY)!.messageId = message.id
    this.ledger.add('message_linked')
    return { id: message.id }
  }

  async complete() {
    this.outbox.status = 'delivered'
    this.outbox.leaseUntil = null
    this.outbox.leaseOwner = null
    this.ledger.add('artifact_saved')
    this.ledger.add('delivered')
  }

  async fail(_outbox: SeoArtifactDeliveryOutbox, error: Error) {
    this.outbox.status = 'retry'
    this.outbox.lastError = error.message
  }
}

describe('Chrome+SEO → worker callback → outbox → native card → web cold reload', () => {
  it('composes Chrome onto the primary SEO skill with one allowlist for discovery and execution', async () => {
    expect(hasExplicitChromeModality(OWNER_TEXT)).toBe(true)
    const composed = composeTurnToolAllowlist(SEO_SKILL_ALLOWLIST, true)!

    // SEO stays primary; the quartet is added, not substituted.
    for (const name of SEO_SKILL_ALLOWLIST) expect(composed.has(name)).toBe(true)
    for (const name of EXPLICIT_CHROME_MODALITY_TOOLS) expect(composed.has(name)).toBe(true)
    expect(composed.has('draft_seo_fixes')).toBe(false)

    // find_tool's own result is filtered by the SAME allowlist the executor uses.
    const discovery = {
      data: {
        matches: [
          { name: 'live_browser_pair' },
          { name: 'live_browser_look' },
          { name: 'live_browser_act' },
          { name: 'run_website_seo_audit' },
          { name: 'draft_seo_fixes' },
        ],
        note: 'raw registry result',
      },
    }
    const filtered = filterFindToolResultForTurn(discovery, {
      already: new Set(),
      turnDenylist: new Set(),
      turnAllowlist: composed,
    })
    expect(filtered.permitted).toEqual([
      'live_browser_pair',
      'live_browser_look',
      'live_browser_act',
      'run_website_seo_audit',
    ])
    expect(filtered.refused).toEqual(['draft_seo_fixes'])
    // A refused name never reaches the model's preview.
    expect(JSON.stringify(discovery)).not.toContain('draft_seo_fixes')

    // Execution-time policy is the same object, so discovery cannot promise a
    // tool the executor would then refuse.
    const policy = {
      ownerText: OWNER_TEXT,
      turnAllowlist: composed,
      turnDenylist: new Set<string>(),
      turnAuthorization: { allowMutations: true, reason: 'explicit_action' as const },
      agentControls: DEFAULT_AGENT_CONTROLS,
      chatMode: 'auto' as const,
      permissionMode: 'standard' as const,
      actorRoles: ['owner' as const],
    }
    const resolved = await resolveToolsByName([...composed, 'draft_seo_fixes'])
    const executable = filterTurnToolDefinitions(resolved, policy).tools.map((tool) => tool.name)
    expect(executable).not.toContain('draft_seo_fixes')
    for (const name of filtered.permitted) {
      // Every discovery-permitted name that exists in the catalog is executable.
      if (resolved.some((tool) => tool.name === name)) expect(executable).toContain(name)
    }
  })

  it('delivers one linkable artifact the native card and a cold web reload both read', async () => {
    const port = new DeliveryPort()
    const delivered = await runSeoArtifactDeliveryStateMachine(
      fixture.pendingActionId,
      port,
      { workerId: 'worker-callback', now: NOW },
    )

    // Durable outbox converged exactly once.
    expect(port.outbox.status).toBe('delivered')
    expect(port.artifacts.size).toBe(1)
    expect(port.messages.size).toBe(1)
    expect(port.storage.size).toBe(4)
    expect(port.ledger).toContain('artifact_saved')
    expect(port.ledger).toContain('delivered')

    const artifact = port.artifacts.get(KEY)!
    const message = port.messages.get(KEY)!
    expect(delivered.artifact).toMatchObject({ id: artifact.id, title: artifact.title })
    // The two production identities that existed but were never linked.
    expect(artifact.id).toBe(fixture.legacyArtifactId)
    expect(message.id).toBe(fixture.legacyMessageId)
    expect(artifact.messageId).toBe(message.id)

    // ── native artifact card ────────────────────────────────────────────────
    expect(message.usage.artifactSaved).toEqual({
      type: 'artifact_saved',
      id: artifact.id,
      title: artifact.title,
      artifactType: artifact.type,
    })
    expect(message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'file_ref',
        path: `${fixture.storagePrefix}/report.html`,
        artifactId: artifact.id,
      }),
    ]))
    expect(message.usage.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ t: 'file', id: artifact.id, name: artifact.title, kind: artifact.type }),
    ]))
    // A later check-callback card must NOT paint a second live card on top of
    // the canonical message the native transcript already shows.
    expect(liveArtifactCard({
      id: artifact.id,
      title: artifact.title,
      type: artifact.type,
      canonicalMessageDelivered: true,
    })).toBeNull()
    // A live-only card (no canonical message) still renders.
    expect(liveArtifactCard({ id: 'live-only', title: 'draft', type: 'markdown' }))
      .toEqual({ id: 'live-only', title: 'draft', type: 'markdown' })

    // ── mounted web cold reload ─────────────────────────────────────────────
    // The reload path reads the persisted row, not the live stream.
    const projected = buildAgentPresentationV1({
      messageId: message.id,
      content: message.content,
      timeline: message.usage.timeline,
    })
    expect(projected.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'file',
        artifactId: artifact.id,
        title: artifact.title,
        kind: artifact.type,
      }),
    ]))
    // A prose-only v2 document would make the reload ignore this timeline and
    // hide the file again — the exact production symptom.
    expect(message.usage.presentationV2).toBeUndefined()
  })

  it('is idempotent: a replayed worker callback adds no second card or message', async () => {
    const port = new DeliveryPort()
    await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, { workerId: 'a', now: NOW })
    const firstArtifact = port.artifacts.get(KEY)!.id
    const firstMessage = port.messages.get(KEY)!.id

    await runSeoArtifactDeliveryStateMachine(fixture.pendingActionId, port, { workerId: 'b', now: NOW })

    expect(port.artifacts.size).toBe(1)
    expect(port.messages.size).toBe(1)
    expect(port.artifacts.get(KEY)!.id).toBe(firstArtifact)
    expect(port.messages.get(KEY)!.id).toBe(firstMessage)
  })
})
