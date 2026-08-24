/**
 * One durable delivery path for a finished SEO audit.
 *
 * The pending-action terminal write and `enqueueSeoArtifactDeliveryTx` share a
 * transaction. Everything after that boundary is replayable: storage uploads
 * are upserts, artifact/message identities are unique, and every crossed crash
 * boundary is recorded in an append-only milestone ledger.
 */
import { createHash, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { agentStorageDownload, agentStorageUpload } from '@/agent/lib/storage'
import { ownerFileLink } from '@/agent/lib/job-delivery'
import {
  buildClientReportHtml,
  buildClientReportMarkdown,
  buildIssuesCsv,
  type AuditJson,
} from '@/agent/lib/seo-report'
import { normalizeAuditUrl } from '@/agent/lib/seo-audit-idempotency'

// Prisma is deliberately kept behind this adapter: the state machine below is
// exercised against an in-memory port at every crash point.
const db = prisma as any

const SOURCE_KIND = 'pending_action'
const LOGICAL_NAME = 'seo-dashboard'
const DELIVERY_VERSION = 1
const LEASE_MS = 90_000

export type SeoStorageReceipt = {
  logicalName: 'dashboard' | 'report' | 'issues' | 'raw'
  path: string
  mediaType: string
  sha256: string
  bytes: number
}

export type SeoArtifactDeliveryBundle = {
  host: string
  title: string
  artifactType: 'html'
  artifactContent: string
  artifactSha256: string
  artifactStoragePath: string
  summaryBn: string
  receipts: SeoStorageReceipt[]
  /** In-memory upload bodies. Receipt hashes are frozen before these are written. */
  storageBodies?: Partial<Record<SeoStorageReceipt['logicalName'], Buffer>>
}

export type SeoArtifactDeliverySource = {
  actionId: string
  conversationId: string
  status: string
  summary: string | null
  payload: unknown
  result: unknown
  resolvedAt: Date | null
}

export type SeoArtifactDeliveryOutbox = {
  id: string
  deliveryKey: string
  sourceId: string
  status: string
  attempts: number
  maxAttempts: number
  leaseUntil: Date | null
  leaseOwner?: string | null
  lastError?: string | null
  storageReceipts?: SeoStorageReceipt[] | null
}

export type SeoArtifactCard = {
  id: string
  title: string
  type: string
  version: number
}

export type SeoArtifactMessage = {
  id: string
  clientRequestId: string
  content: Array<Record<string, unknown>>
  usage: Record<string, unknown> & { timeline: Array<Record<string, unknown>> }
}

export interface SeoArtifactDeliveryPort {
  load(actionId: string): Promise<{
    outbox: SeoArtifactDeliveryOutbox | null
    source: SeoArtifactDeliverySource | null
  }>
  claim(actionId: string, leaseOwner: string, leaseUntil: Date): Promise<SeoArtifactDeliveryOutbox | null>
  prepareStorage(
    source: SeoArtifactDeliverySource,
    outbox: SeoArtifactDeliveryOutbox,
  ): Promise<SeoArtifactDeliveryBundle>
  persistStorage(
    outbox: SeoArtifactDeliveryOutbox,
    bundle: SeoArtifactDeliveryBundle,
    source: SeoArtifactDeliverySource,
  ): Promise<void>
  upsertArtifact(
    outbox: SeoArtifactDeliveryOutbox,
    bundle: SeoArtifactDeliveryBundle,
    source: SeoArtifactDeliverySource,
  ): Promise<SeoArtifactCard>
  upsertMessage(
    outbox: SeoArtifactDeliveryOutbox,
    bundle: SeoArtifactDeliveryBundle,
    artifact: SeoArtifactCard,
    source: SeoArtifactDeliverySource,
  ): Promise<{ id: string }>
  complete(
    outbox: SeoArtifactDeliveryOutbox,
    bundle: SeoArtifactDeliveryBundle,
    artifact: SeoArtifactCard,
    message: { id: string },
    source: SeoArtifactDeliverySource,
  ): Promise<void>
  fail(outbox: SeoArtifactDeliveryOutbox, error: Error, now: Date): Promise<void>
}

export function seoArtifactOutboxEnabled(env?: { AGENT_ARTIFACT_OUTBOX?: string }): boolean {
  const flag = env ? env.AGENT_ARTIFACT_OUTBOX : process.env.AGENT_ARTIFACT_OUTBOX
  return !['0', 'false', 'off'].includes(String(flag ?? '').trim().toLowerCase())
}

export function artifactDeliveryKey(actionId: string): string {
  return `artifact:pending_action:${actionId}:${LOGICAL_NAME}:v${DELIVERY_VERSION}`
}

const artifactMessageRequestId = (deliveryKey: string) => `artifact-delivery:${deliveryKey}`
const sha256 = (body: Buffer | string) => createHash('sha256').update(body).digest('hex')

function deliveryText(bundle: SeoArtifactDeliveryBundle): string {
  const labels: Record<SeoStorageReceipt['logicalName'], string> = {
    dashboard: 'লাইভ ড্যাশবোর্ড (HTML)',
    report: 'পুরো রিপোর্ট (md)',
    issues: 'সব issue (Excel/CSV)',
    raw: 'raw findings (json)',
  }
  const links = bundle.receipts
    .map((receipt) => `- [${labels[receipt.logicalName]}](${ownerFileLink(receipt.path)})`)
    .join('\n')
  return `${bundle.summaryBn}\n\n**ফাইল:**\n${links}`
}

export function buildSeoArtifactMessage(input: {
  messageId: string
  deliveryKey: string
  outboxId: string
  artifact: SeoArtifactCard
  bundle: SeoArtifactDeliveryBundle
}): SeoArtifactMessage {
  const text = deliveryText(input.bundle)
  return {
    id: input.messageId,
    clientRequestId: artifactMessageRequestId(input.deliveryKey),
    content: [
      { type: 'text', text },
      {
        type: 'file_ref',
        bucket: 'agent-files',
        path: input.bundle.artifactStoragePath,
        mediaType: 'text/html',
        artifactId: input.artifact.id,
        title: input.artifact.title,
      },
    ],
    usage: {
      timeline: [
        { t: 'text', text },
        { t: 'file', id: input.artifact.id, name: input.artifact.title, kind: input.artifact.type },
      ],
      // Deliberately no prose-only presentationV2 document: AgentApp gives a
      // v2 projection precedence over usage.timeline on cold load. The raw
      // timeline is canonical here so its file card survives web+iOS reload.
      artifactDelivery: {
        version: 1,
        deliveryKey: input.deliveryKey,
        outboxId: input.outboxId,
        storageReceipts: input.bundle.receipts,
      },
      // Event-shaped durable metadata for cold-load/audit. This background
      // write is not itself an SSE emission.
      artifactSaved: {
        type: 'artifact_saved',
        id: input.artifact.id,
        title: input.artifact.title,
        artifactType: input.artifact.type,
      },
    },
  }
}

export async function runSeoArtifactDeliveryStateMachine(
  actionId: string,
  port: SeoArtifactDeliveryPort,
  opts: { workerId?: string; now?: Date } = {},
): Promise<{ status: string; idempotent?: boolean; artifact?: SeoArtifactCard; messageId?: string }> {
  const now = opts.now ?? new Date()
  const loaded = await port.load(actionId)
  if (!loaded.outbox || !loaded.source) return { status: 'missing' }
  if (loaded.outbox.status === 'delivered') return { status: 'delivered', idempotent: true }
  if (loaded.source.status !== 'executed') return { status: 'not_ready' }

  const workerId = opts.workerId ?? `artifact-${process.pid}-${randomUUID()}`
  const claimed = await port.claim(actionId, workerId, new Date(now.getTime() + LEASE_MS))
  if (!claimed) {
    const latest = await port.load(actionId)
    return latest.outbox?.status === 'delivered'
      ? { status: 'delivered', idempotent: true }
      : { status: latest.outbox?.status ?? 'missing', idempotent: true }
  }

  try {
    const bundle = await port.prepareStorage(loaded.source, claimed)
    await port.persistStorage(claimed, bundle, loaded.source)
    const artifact = await port.upsertArtifact(claimed, bundle, loaded.source)
    const message = await port.upsertMessage(claimed, bundle, artifact, loaded.source)
    await port.complete(claimed, bundle, artifact, message, loaded.source)
    return { status: 'delivered', artifact, messageId: message.id }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    await port.fail(claimed, error, now)
    return { status: claimed.attempts >= claimed.maxAttempts ? 'dead' : 'retry' }
  }
}

const SEV_LABEL: Record<string, string> = {
  critical: '🔴 জরুরি',
  high: '🟠 গুরুতর',
  medium: '🟡 মাঝারি',
  low: '⚪ ছোট',
}

function topIssueLines(audit: AuditJson, limit = 5): string[] {
  const groups = new Map<string, { severity: string; detail: string; count: number }>()
  const push = (severity: string, code: string, detail: string) => {
    const key = `${severity}|${code}`
    const previous = groups.get(key)
    groups.set(key, { severity, detail, count: (previous?.count ?? 0) + 1 })
  }
  for (const issue of audit.siteChecks?.issues ?? []) push(issue.severity, issue.code, issue.detail)
  for (const page of audit.pages ?? []) {
    for (const issue of page.issues ?? []) push(issue.severity, issue.code, issue.detail)
  }
  const order = ['critical', 'high', 'medium', 'low']
  return [...groups.values()]
    .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || b.count - a.count)
    .slice(0, limit)
    .map((group) => `- ${SEV_LABEL[group.severity] ?? group.severity} ${group.detail} — ${group.count}টা জায়গায়`)
}

function assertHttpAuditUrl(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`seo_artifact_missing_${label}_url`)
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error(`seo_artifact_invalid_${label}_url`) }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`seo_artifact_invalid_${label}_url`)
  return parsed.toString()
}

function assertSafeSeoStoragePath(path: string, prefix: string): void {
  if (
    !path.startsWith(`${prefix}/`)
    || path.includes('?')
    || path.includes('#')
    || path.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(path)
    || /%(?:2e|2f|5c)/i.test(path)
  ) throw new Error('seo_artifact_invalid_storage_path')
  const relative = path.slice(prefix.length + 1)
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('seo_artifact_invalid_storage_path')
  }
}

function validateSeoArtifactStoragePaths(
  source: SeoArtifactDeliverySource,
): { prefix: string; rawPath: string; reportPath: string; csvPath: string; htmlPath: string } {
  if (!/^[a-zA-Z0-9_-]+$/.test(source.actionId)) throw new Error('seo_artifact_invalid_action_id')
  const prefix = `seo-audits/${source.actionId}`
  const result = source.result && typeof source.result === 'object' && !Array.isArray(source.result)
    ? source.result as Record<string, unknown>
    : {}
  const paths = Array.isArray(result.artifacts)
    ? result.artifacts.filter((path): path is string => typeof path === 'string')
    : []
  for (const path of paths) assertSafeSeoStoragePath(path, prefix)
  const rawPath = `${prefix}/audit.json`
  if (!paths.includes(rawPath)) throw new Error('seo_artifact_missing_audit_json')
  return {
    prefix,
    rawPath,
    reportPath: `${prefix}/report.md`,
    csvPath: `${prefix}/issues.csv`,
    htmlPath: `${prefix}/report.html`,
  }
}

function validateSeoArtifactAuditUrl(source: SeoArtifactDeliverySource, auditUrl: unknown): void {
  const payload = source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
    ? source.payload as Record<string, unknown>
    : {}
  const expectedUrl = assertHttpAuditUrl(payload.url, 'payload')
  const actualUrl = assertHttpAuditUrl(auditUrl, 'audit')
  if (normalizeAuditUrl(expectedUrl) !== normalizeAuditUrl(actualUrl)) {
    throw new Error('seo_artifact_audit_url_mismatch')
  }
}

/** Validate the worker-owned source before any generated object is uploaded. */
export function validateSeoArtifactSource(
  source: SeoArtifactDeliverySource,
  auditUrl: unknown,
): { prefix: string; rawPath: string; reportPath: string; csvPath: string; htmlPath: string } {
  const paths = validateSeoArtifactStoragePaths(source)
  validateSeoArtifactAuditUrl(source, auditUrl)
  return paths
}

function comparableReceipts(receipts: SeoStorageReceipt[]): string {
  return JSON.stringify([...receipts]
    .sort((a, b) => a.logicalName.localeCompare(b.logicalName))
    .map(({ logicalName, path, mediaType, sha256: digest, bytes }) => ({
      logicalName, path, mediaType, sha256: digest, bytes,
    })))
}

/** First receipt set owns the canonical content; retries may only reproduce it. */
export function assertSeoStorageReceiptsStable(
  frozen: SeoStorageReceipt[] | null | undefined,
  current: SeoStorageReceipt[],
): void {
  if (!frozen) return
  if (comparableReceipts(frozen) !== comparableReceipts(current)) {
    throw new Error('seo_artifact_source_mutated_after_receipt')
  }
}

async function prepareSeoStorage(
  source: SeoArtifactDeliverySource,
  outbox: SeoArtifactDeliveryOutbox,
): Promise<SeoArtifactDeliveryBundle> {
  const validated = validateSeoArtifactStoragePaths(source)
  const jsonPath = validated.rawPath

  const raw = await agentStorageDownload(jsonPath)
  const audit = JSON.parse(raw.toString('utf8')) as AuditJson
  validateSeoArtifactAuditUrl(source, audit.url)
  const keywordsNote = ((source.payload as Record<string, unknown> | null)?.keywordsNote ?? null) as string | null
  const { reportPath, csvPath, htmlPath } = validated
  const report = Buffer.from(buildClientReportMarkdown(audit, { keywordsNote }), 'utf8')
  const csv = Buffer.from(buildIssuesCsv(audit), 'utf8')
  const html = Buffer.from(buildClientReportHtml(audit, { keywordsNote }), 'utf8')

  const host = (() => {
    try { return new URL(audit.url).hostname.replace(/^www\./, '') } catch { return audit.url }
  })()
  const pagesCrawled = audit.pagesCrawled ?? audit.pages?.length ?? 0
  const sitemapCount = audit.sitemap?.count ?? 0
  const coverage = sitemapCount ? `${pagesCrawled}/${sitemapCount} পেজ (sitemap অনুযায়ী)` : `${pagesCrawled} পেজ`
  const counts = audit.counts
  const summaryBn = [
    `Boss, **${host}**-এর পূর্ণ SEO অডিট শেষ।`,
    '',
    `**স্কোর: ${audit.score}/100** · দেখা হয়েছে ${coverage}`,
    `সমস্যা: 🔴 ${counts.critical} · 🟠 ${counts.high} · 🟡 ${counts.medium} · ⚪ ${counts.low}`,
    '',
    '**সবচেয়ে বড় সমস্যাগুলো:**',
    ...topIssueLines(audit),
    '',
    'বিস্তারিত প্রমাণ, প্রতিটার সমাধান আর অগ্রাধিকার-প্ল্যান ড্যাশবোর্ডে (নিচের ফাইলে) আছে।',
  ].join('\n')
  const receipts: SeoStorageReceipt[] = [
    { logicalName: 'dashboard', path: htmlPath, mediaType: 'text/html', sha256: sha256(html), bytes: html.byteLength },
    { logicalName: 'report', path: reportPath, mediaType: 'text/markdown', sha256: sha256(report), bytes: report.byteLength },
    { logicalName: 'issues', path: csvPath, mediaType: 'text/csv', sha256: sha256(csv), bytes: csv.byteLength },
    { logicalName: 'raw', path: jsonPath, mediaType: 'application/json', sha256: sha256(raw), bytes: raw.byteLength },
  ]
  assertSeoStorageReceiptsStable(outbox.storageReceipts, receipts)
  return {
    host,
    title: `SEO অডিট ড্যাশবোর্ড — ${host}`,
    artifactType: 'html',
    artifactContent: html.toString('utf8'),
    artifactSha256: sha256(html),
    artifactStoragePath: htmlPath,
    summaryBn,
    receipts,
    storageBodies: { dashboard: html, report, issues: csv },
  }
}

async function ledger(tx: any, outboxId: string, milestone: string, payload?: unknown) {
  await tx.agentArtifactDeliveryLedger.upsert({
    where: { outboxId_milestone: { outboxId, milestone } },
    create: { outboxId, milestone, ...(payload === undefined ? {} : { payload }) },
    update: {},
  })
}

function actionResultWithBundle(result: unknown, bundle: SeoArtifactDeliveryBundle) {
  const current = (result ?? {}) as Record<string, unknown>
  const previousDelivery = current.__delivery && typeof current.__delivery === 'object'
    ? current.__delivery as Record<string, unknown>
    : null
  const existingArtifacts = Array.isArray(current.artifacts)
    ? current.artifacts.filter((path): path is string => typeof path === 'string')
    : []
  const artifacts = [...new Set([
    ...existingArtifacts,
    ...bundle.receipts.map((receipt) => receipt.path),
  ])]
  return {
    ...current,
    artifacts,
    deliverySummaryBn: bundle.summaryBn,
    deliveryLinks: {
      dashboardUrl: ownerFileLink(bundle.receipts.find((r) => r.logicalName === 'dashboard')!.path),
      reportUrl: ownerFileLink(bundle.receipts.find((r) => r.logicalName === 'report')!.path),
      issuesCsvUrl: ownerFileLink(bundle.receipts.find((r) => r.logicalName === 'issues')!.path),
      auditJsonUrl: ownerFileLink(bundle.receipts.find((r) => r.logicalName === 'raw')!.path),
    },
    __delivery: previousDelivery?.state === 'delivered'
      ? previousDelivery
      : {
          state: 'pending',
          attempts: Number(previousDelivery?.attempts) || 0,
          since: typeof previousDelivery?.since === 'string' ? previousDelivery.since : new Date().toISOString(),
        },
  }
}

export function findLegacySeoDeliveryMessage<T extends {
  id: string
  conversationId: string
  role: string
  clientRequestId?: string | null
  content: unknown
  usage?: unknown
}>(rows: T[], bundle: SeoArtifactDeliveryBundle, conversationId: string): T | null {
  const expectedText = deliveryText(bundle).replace(/\r\n/g, '\n').trim()
  return rows.find((row) => {
    if (row.conversationId !== conversationId || row.role !== 'assistant' || row.clientRequestId) return false
    const blocks = Array.isArray(row.content) ? row.content : []
    const text = typeof row.content === 'string'
      ? row.content
      : blocks
          .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
          .map((block) => typeof block.text === 'string' ? block.text : '')
          .join('\n')
    return text.replace(/\r\n/g, '\n').trim() === expectedText
  }) ?? null
}

function prismaPort(): SeoArtifactDeliveryPort {
  return {
    async load(actionId) {
      const [outbox, action] = await Promise.all([
        db.agentArtifactDeliveryOutbox.findFirst({
          where: { sourceKind: SOURCE_KIND, sourceId: actionId, logicalName: LOGICAL_NAME, version: DELIVERY_VERSION },
        }),
        db.agentPendingAction.findUnique({
          where: { id: actionId },
          select: {
            id: true, conversationId: true, status: true, summary: true,
            payload: true, result: true, resolvedAt: true, type: true,
          },
        }),
      ])
      const payloadConversationId = typeof (action?.payload as Record<string, unknown> | null)?.conversationId === 'string'
        ? String((action?.payload as Record<string, unknown>).conversationId).trim()
        : ''
      const actionConversationId = action?.conversationId || payloadConversationId || null
      if (outbox && actionConversationId && outbox.conversationId !== actionConversationId) {
        throw new Error('seo_artifact_conversation_binding_mismatch')
      }
      const conversationId = outbox?.conversationId || actionConversationId
      const conversationExists = conversationId
        ? Boolean(await db.agentConversation.findUnique({ where: { id: conversationId }, select: { id: true } }))
        : false
      return {
        outbox,
        source: action?.type === 'seo_audit' && conversationId && conversationExists
          ? {
              actionId: action.id,
              conversationId,
              status: action.status,
              summary: action.summary,
              payload: action.payload,
              result: action.result,
              resolvedAt: action.resolvedAt,
            }
          : null,
      }
    },

    async claim(actionId, leaseOwner, leaseUntil) {
      const now = new Date()
      const row = await db.agentArtifactDeliveryOutbox.findFirst({
        where: { sourceKind: SOURCE_KIND, sourceId: actionId, logicalName: LOGICAL_NAME, version: DELIVERY_VERSION },
        select: { id: true, status: true, attempts: true, maxAttempts: true, leaseUntil: true },
      })
      if (!row) return null

      // A process can die after the lease/attempt increment and before its
      // catch/fail handler. Once the final such lease expires, no future claim
      // is legal; terminalize it explicitly instead of leaving `processing`
      // immortal with attempts==max.
      if (
        row.status === 'processing'
        && row.attempts >= row.maxAttempts
        && row.leaseUntil instanceof Date
        && row.leaseUntil <= now
      ) {
        await db.$transaction(async (tx: typeof db) => {
          const terminalized = await tx.agentArtifactDeliveryOutbox.updateMany({
            where: {
              id: row.id,
              status: 'processing',
              attempts: { gte: row.maxAttempts },
              leaseUntil: { lte: now },
            },
            data: {
              status: 'dead',
              leaseUntil: null,
              leaseOwner: null,
              lastError: 'lease_expired_after_max_attempts',
            },
          })
          if (terminalized.count === 1) {
            await ledger(tx, row.id, 'dead', {
              reason: 'lease_expired_after_max_attempts',
              attempts: row.attempts,
            })
          }
        })
        return null
      }
      const claimed = await db.agentArtifactDeliveryOutbox.updateMany({
        where: {
          id: row.id,
          attempts: { lt: row.maxAttempts },
          OR: [
            { status: { in: ['pending', 'retry'] }, availableAt: { lte: now } },
            { status: 'processing', leaseUntil: { lt: now } },
          ],
        },
        data: {
          status: 'processing', leaseOwner, leaseUntil,
          attempts: { increment: 1 }, lastError: null,
        },
      })
      return claimed.count === 1
        ? db.agentArtifactDeliveryOutbox.findUnique({ where: { id: row.id } })
        : null
    },

    prepareStorage: prepareSeoStorage,

    async persistStorage(outbox, bundle, source) {
      // Freeze hashes/paths before the first generated-object write. If the
      // process dies mid-upload, the retry must reproduce these exact bytes.
      await db.$transaction(async (tx: typeof db) => {
        const current = await tx.agentArtifactDeliveryOutbox.findUnique({
          where: { id: outbox.id },
          select: { storageReceipts: true },
        })
        if (!current) throw new Error('seo_artifact_outbox_missing')
        const frozen = Array.isArray(current.storageReceipts)
          ? current.storageReceipts as SeoStorageReceipt[]
          : null
        assertSeoStorageReceiptsStable(frozen, bundle.receipts)
        if (!frozen) {
          await tx.agentArtifactDeliveryOutbox.update({
            where: { id: outbox.id },
            data: { storageReceipts: bundle.receipts },
          })
          await ledger(tx, outbox.id, 'source_frozen', { receipts: bundle.receipts })
        }
      })

      for (const receipt of bundle.receipts) {
        if (receipt.logicalName === 'raw') continue
        const body = bundle.storageBodies?.[receipt.logicalName]
        if (!body || sha256(body) !== receipt.sha256 || body.byteLength !== receipt.bytes) {
          throw new Error('seo_artifact_upload_body_receipt_mismatch')
        }
        await agentStorageUpload(receipt.path, body, receipt.mediaType, { upsert: true })
      }

      await db.$transaction(async (tx: typeof db) => {
        const action = await tx.agentPendingAction.findUnique({ where: { id: source.actionId }, select: { result: true } })
        await tx.agentPendingAction.update({
          where: { id: source.actionId },
          data: { result: actionResultWithBundle(action?.result, bundle) },
        })
        await ledger(tx, outbox.id, 'storage_persisted', { receipts: bundle.receipts })
      })
    },

    async upsertArtifact(outbox, bundle, source) {
      const byKey = await db.agentArtifact.findUnique({ where: { deliveryKey: outbox.deliveryKey } })
      if (byKey && (
        byKey.conversationId !== source.conversationId
        || (byKey.contentSha256 && byKey.contentSha256 !== bundle.artifactSha256)
      )) throw new Error('seo_artifact_binding_or_content_mismatch')
      let candidate = byKey
      if (!candidate) {
        const legacy = await db.agentArtifact.findFirst({
          where: {
            conversationId: source.conversationId,
            title: bundle.title,
            type: bundle.artifactType,
            deliveryKey: null,
          },
          orderBy: { createdAt: 'desc' },
        })
        if (legacy && sha256(String(legacy.content ?? '')) === bundle.artifactSha256) candidate = legacy
      }

      try {
        return await db.$transaction(async (tx: typeof db) => {
          const row = candidate
            ? await tx.agentArtifact.update({
                where: { id: candidate.id },
                data: {
                  deliveryKey: outbox.deliveryKey,
                  contentSha256: bundle.artifactSha256,
                  storagePath: bundle.artifactStoragePath,
                  content: bundle.artifactContent,
                  title: bundle.title,
                  type: bundle.artifactType,
                },
              })
            : await tx.agentArtifact.create({
                data: {
                  conversationId: source.conversationId,
                  deliveryKey: outbox.deliveryKey,
                  contentSha256: bundle.artifactSha256,
                  storagePath: bundle.artifactStoragePath,
                  content: bundle.artifactContent,
                  title: bundle.title,
                  type: bundle.artifactType,
                  version: 1,
                },
              })
          await tx.agentArtifactDeliveryOutbox.update({ where: { id: outbox.id }, data: { artifactId: row.id } })
          await ledger(tx, outbox.id, 'artifact_linked', {
            artifactId: row.id,
            title: row.title ?? bundle.title,
            type: row.type ?? 'html',
            adopted: Boolean(candidate),
          })
          return { id: row.id, title: row.title ?? bundle.title, type: row.type ?? 'html', version: row.version }
        })
      } catch (error) {
        // A concurrent dispatcher may have won the unique delivery key. Adopt
        // that winner rather than turning a harmless race into a dead outbox.
        const winner = await db.agentArtifact.findUnique({ where: { deliveryKey: outbox.deliveryKey } })
        if (!winner) throw error
        if (
          winner.conversationId !== source.conversationId
          || (winner.contentSha256 && winner.contentSha256 !== bundle.artifactSha256)
        ) throw new Error('seo_artifact_binding_or_content_mismatch')
        await db.$transaction(async (tx: typeof db) => {
          await tx.agentArtifactDeliveryOutbox.update({ where: { id: outbox.id }, data: { artifactId: winner.id } })
          await ledger(tx, outbox.id, 'artifact_linked', {
            artifactId: winner.id,
            title: winner.title ?? bundle.title,
            type: winner.type ?? 'html',
            raced: true,
          })
        })
        return { id: winner.id, title: winner.title ?? bundle.title, type: winner.type ?? 'html', version: winner.version }
      }
    },

    async upsertMessage(outbox, bundle, artifact, source) {
      const requestId = artifactMessageRequestId(outbox.deliveryKey)
      let existing = await db.agentMessage.findUnique({ where: { clientRequestId: requestId } })
      if (existing && (
        existing.conversationId !== source.conversationId
        || existing.role !== 'assistant'
      )) throw new Error('seo_artifact_message_binding_mismatch')
      if (!existing) {
        const linked = await db.agentArtifact.findUnique({ where: { id: artifact.id }, select: { messageId: true } })
        if (linked?.messageId) {
          const linkedMessage = await db.agentMessage.findUnique({ where: { id: linked.messageId } })
          if (linkedMessage && findLegacySeoDeliveryMessage([linkedMessage], bundle, source.conversationId)) {
            existing = linkedMessage
          }
        }
      }
      if (!existing) {
        const after = source.resolvedAt
          ? new Date(source.resolvedAt.getTime() - 5 * 60_000)
          : new Date(Date.now() - 24 * 3600_000)
        const legacyRows = await db.agentMessage.findMany({
          where: { conversationId: source.conversationId, role: 'assistant', createdAt: { gte: after } },
          orderBy: { createdAt: 'asc' },
          take: 30,
          select: {
            id: true, conversationId: true, role: true, clientRequestId: true,
            content: true, usage: true, createdAt: true,
          },
        })
        existing = findLegacySeoDeliveryMessage(legacyRows, bundle, source.conversationId)
      }
      const messageId = existing?.id ?? randomUUID()
      const canonical = buildSeoArtifactMessage({
        messageId,
        deliveryKey: outbox.deliveryKey,
        outboxId: outbox.id,
        artifact,
        bundle,
      })

      try {
        return await db.$transaction(async (tx: typeof db) => {
          const row = existing
            ? await tx.agentMessage.update({
                where: { id: existing.id },
                data: {
                  clientRequestId: canonical.clientRequestId,
                  content: canonical.content,
                  usage: canonical.usage,
                },
              })
            : await tx.agentMessage.create({
                data: {
                  id: canonical.id,
                  clientRequestId: canonical.clientRequestId,
                  conversationId: source.conversationId,
                  role: 'assistant',
                  content: canonical.content,
                  usage: canonical.usage,
                  tokensIn: 0,
                  tokensOut: 0,
                  costUsd: 0,
                },
              })
          await tx.agentArtifact.update({ where: { id: artifact.id }, data: { messageId: row.id } })
          await tx.agentArtifactDeliveryOutbox.update({ where: { id: outbox.id }, data: { messageId: row.id } })
          const linkedAt = new Date()
          await tx.agentConversation.update({
            where: { id: source.conversationId },
            data: { updatedAt: linkedAt, lastMessageAt: linkedAt },
          })
          await ledger(tx, outbox.id, 'message_linked', { messageId: row.id, adopted: Boolean(existing) })
          return { id: row.id }
        })
      } catch (error) {
        const winner = await db.agentMessage.findUnique({ where: { clientRequestId: requestId } })
        if (!winner) throw error
        if (winner.conversationId !== source.conversationId || winner.role !== 'assistant') {
          throw new Error('seo_artifact_message_binding_mismatch')
        }
        await db.$transaction(async (tx: typeof db) => {
          await tx.agentArtifact.update({ where: { id: artifact.id }, data: { messageId: winner.id } })
          await tx.agentArtifactDeliveryOutbox.update({ where: { id: outbox.id }, data: { messageId: winner.id } })
          const linkedAt = new Date()
          await tx.agentConversation.update({
            where: { id: source.conversationId },
            data: { updatedAt: linkedAt, lastMessageAt: linkedAt },
          })
          await ledger(tx, outbox.id, 'message_linked', { messageId: winner.id, raced: true })
        })
        return { id: winner.id }
      }
    },

    async complete(outbox, _bundle, artifact, message, source) {
      await db.$transaction(async (tx: typeof db) => {
        const action = await tx.agentPendingAction.findUnique({ where: { id: source.actionId }, select: { result: true } })
        const result = (action?.result ?? {}) as Record<string, unknown>
        const previous = result.__delivery && typeof result.__delivery === 'object'
          ? result.__delivery as Record<string, unknown>
          : {}
        await tx.agentPendingAction.update({
          where: { id: source.actionId },
          data: {
            result: {
              ...result,
              __delivery: {
                state: 'delivered',
                attempts: Number(previous.attempts) || 0,
                since: typeof previous.since === 'string' ? previous.since : new Date().toISOString(),
                deliveredAt: new Date().toISOString(),
                via: 'artifact_outbox',
                artifactId: artifact.id,
                messageId: message.id,
              },
            },
          },
        })
        const deliveredAt = new Date()
        await tx.agentConversation.update({
          where: { id: source.conversationId },
          data: { updatedAt: deliveredAt, lastMessageAt: deliveredAt },
        })
        await tx.agentArtifactDeliveryOutbox.update({
          where: { id: outbox.id },
          data: {
            status: 'delivered',
            artifactId: artifact.id,
            messageId: message.id,
            deliveredAt: new Date(),
            leaseUntil: null,
            leaseOwner: null,
            lastError: null,
          },
        })
        await ledger(tx, outbox.id, 'artifact_saved', {
          artifactId: artifact.id,
          title: artifact.title,
          type: artifact.type,
          messageId: message.id,
        })
        await ledger(tx, outbox.id, 'delivered', {
          artifactId: artifact.id,
          title: artifact.title,
          type: artifact.type,
          messageId: message.id,
        })
      })
    },

    async fail(outbox, error, now) {
      const dead = outbox.attempts >= outbox.maxAttempts
      const delayMs = Math.min(10 * 60_000, 5_000 * 2 ** Math.min(outbox.attempts, 7))
      await db.$transaction(async (tx: typeof db) => {
        // Fenced by lease ownership: if this dispatcher overran its 90s lease,
        // another one may have reclaimed AND delivered the same outbox. An
        // unconditional update here overwrote that winner's `delivered` with
        // `retry`/`dead`, hiding an already-created card and burning attempts
        // (Codex P2, PR #847). Only the current lease owner may record a
        // failure, and only while the row is still `processing`.
        // A claimed row always carries its owner; a missing one means this
        // caller was never the claimant, so it may not record anything.
        if (!outbox.leaseOwner) {
          await ledger(tx, outbox.id, 'stale_failure_ignored', {
            error: error.message.slice(0, 300),
            leaseOwner: null,
          })
          return
        }
        const fenced = await tx.agentArtifactDeliveryOutbox.updateMany({
          where: {
            id: outbox.id,
            status: 'processing',
            leaseOwner: outbox.leaseOwner,
          },
          data: {
            status: dead ? 'dead' : 'retry',
            availableAt: new Date(now.getTime() + delayMs),
            leaseUntil: null,
            leaseOwner: null,
            lastError: error.message.slice(0, 1000),
          },
        })
        if (fenced.count !== 1) {
          await ledger(tx, outbox.id, 'stale_failure_ignored', {
            error: error.message.slice(0, 300),
            leaseOwner: outbox.leaseOwner ?? null,
          })
          return
        }
        await ledger(tx, outbox.id, `attempt_failed:${outbox.attempts}`, {
          error: error.message.slice(0, 500),
          retryable: !dead,
        })
        if (dead) {
          await ledger(tx, outbox.id, 'dead', {
            reason: 'max_attempts_exhausted',
            attempts: outbox.attempts,
          })
        }
      })
    },
  }
}

/** Call inside the SAME transaction that marks the seo_audit action executed. */
export async function enqueueSeoArtifactDeliveryTx(tx: any, input: {
  actionId: string
  conversationId: string
}): Promise<{ id: string; deliveryKey: string }> {
  const deliveryKey = artifactDeliveryKey(input.actionId)
  const outbox = await tx.agentArtifactDeliveryOutbox.upsert({
    where: { deliveryKey },
    create: {
      deliveryKey,
      sourceKind: SOURCE_KIND,
      sourceId: input.actionId,
      conversationId: input.conversationId,
      logicalName: LOGICAL_NAME,
      version: DELIVERY_VERSION,
      status: 'pending',
      spec: { kind: 'seo_audit', sourceActionId: input.actionId, version: DELIVERY_VERSION },
    },
    // Source ownership is immutable. Replay may create a missing row, but it
    // must never retarget an existing delivery to another conversation.
    update: {},
  })
  if (
    outbox.sourceKind !== SOURCE_KIND
    || outbox.sourceId !== input.actionId
    || outbox.logicalName !== LOGICAL_NAME
    || outbox.version !== DELIVERY_VERSION
    || outbox.conversationId !== input.conversationId
  ) throw new Error('seo_artifact_conversation_binding_mismatch')
  await ledger(tx, outbox.id, 'enqueued', { sourceKind: SOURCE_KIND, sourceId: input.actionId })
  return { id: outbox.id, deliveryKey }
}

/** Replay-safe constructor used by duplicate callbacks and repair sweeps. */
export async function ensureSeoArtifactDeliveryOutbox(actionId: string): Promise<boolean> {
  if (!seoArtifactOutboxEnabled()) return false
  const action = await db.agentPendingAction.findUnique({
    where: { id: actionId },
    select: { id: true, type: true, status: true, conversationId: true, payload: true },
  })
  const payloadConversationId = typeof (action?.payload as Record<string, unknown> | null)?.conversationId === 'string'
    ? String((action?.payload as Record<string, unknown>).conversationId).trim()
    : ''
  const conversationId = action?.conversationId || payloadConversationId
  if (action?.type !== 'seo_audit' || action.status !== 'executed' || !conversationId) return false
  await db.$transaction((tx: typeof db) => enqueueSeoArtifactDeliveryTx(tx, {
    actionId: action.id,
    conversationId,
  }))
  return true
}

export async function dispatchSeoArtifactDeliveryForAction(
  actionId: string,
): Promise<{ status: string; idempotent?: boolean; artifact?: SeoArtifactCard; messageId?: string }> {
  if (!seoArtifactOutboxEnabled()) return { status: 'disabled' }
  return runSeoArtifactDeliveryStateMachine(actionId, prismaPort())
}

export async function ensureAndDispatchSeoArtifactDelivery(actionId: string) {
  if (!await ensureSeoArtifactDeliveryOutbox(actionId)) return { status: 'not_ready' }
  return dispatchSeoArtifactDeliveryForAction(actionId)
}

/**
 * Bounded rolling-deploy repair for historical server-spine deliveries. The
 * migration handles the full population; this live path heals rows created
 * while old and new app versions overlap, without requiring worker replay.
 */
export async function repairMissingSeoArtifactOutboxes(limit = 4): Promise<{
  scanned: number
  enqueued: number
}> {
  if (!seoArtifactOutboxEnabled()) return { scanned: 0, enqueued: 0 }
  const take = Math.max(1, Math.min(limit, 10))
  const cutoff = new Date(Date.now() - 180 * 24 * 3600_000)
  const actions = await db.$queryRaw(Prisma.sql`
    SELECT
      action."id",
      COALESCE(
        NULLIF(BTRIM(action."conversationId"), ''),
        NULLIF(BTRIM(action."payload"->>'conversationId'), '')
      ) AS "conversationId"
    FROM "agent_pending_actions" action
    JOIN "agent_conversations" conversation
      ON conversation."id" = COALESCE(
        NULLIF(BTRIM(action."conversationId"), ''),
        NULLIF(BTRIM(action."payload"->>'conversationId'), '')
      )
    LEFT JOIN "agent_artifact_delivery_outbox" outbox
      ON outbox."source_kind" = ${SOURCE_KIND}
      AND outbox."source_id" = action."id"
      AND outbox."logical_name" = ${LOGICAL_NAME}
      AND outbox."version" = ${DELIVERY_VERSION}
    WHERE action."type" = 'seo_audit'
      AND action."status" = 'executed'
      AND action."resolvedAt" >= ${cutoff}
      AND action."result" #>> '{__delivery,via}' IN ('server_spine', 'server_fallback')
      AND action."result"::text LIKE '%audit.json%'
      AND outbox."id" IS NULL
    ORDER BY action."resolvedAt" ASC
    LIMIT ${take}
  `) as Array<{ id: string; conversationId: string }>
  let enqueued = 0
  for (const action of actions) {
    await db.$transaction((tx: typeof db) => enqueueSeoArtifactDeliveryTx(tx, {
      actionId: action.id,
      conversationId: action.conversationId,
    }))
    enqueued++
  }
  return { scanned: actions.length, enqueued }
}

/** Only a fully delivered row may advertise a canonical card on the live path. */
export async function readSeoArtifactCard(input: {
  actionId: string
  conversationId: string | null
}): Promise<SeoArtifactCard | null> {
  const outbox = db.agentArtifactDeliveryOutbox?.findFirst
    ? await db.agentArtifactDeliveryOutbox.findFirst({
        where: { sourceKind: SOURCE_KIND, sourceId: input.actionId, logicalName: LOGICAL_NAME, version: DELIVERY_VERSION },
        select: { status: true, conversationId: true, artifactId: true, messageId: true },
      }).catch(() => null)
    : null
  if (outbox) {
    if (
      outbox.status !== 'delivered'
      || !outbox.artifactId
      || !outbox.messageId
      || (input.conversationId && outbox.conversationId !== input.conversationId)
      || !db.agentArtifact?.findUnique
      || !db.agentMessage?.findUnique
    ) return null
    const artifact = await db.agentArtifact.findUnique({ where: { id: outbox.artifactId } })
    const message = await db.agentMessage.findUnique({ where: { id: outbox.messageId }, select: { id: true, conversationId: true, role: true } })
    if (
      artifact
      && artifact.messageId === outbox.messageId
      && artifact.conversationId === outbox.conversationId
      && message?.conversationId === outbox.conversationId
      && message.role === 'assistant'
    ) return {
      id: artifact.id,
      title: artifact.title ?? 'SEO অডিট রিপোর্ট',
      type: artifact.type ?? 'html',
      version: artifact.version,
    }
    return null
  }

  // With the durable path enabled, a legacy artifact without an outbox is a
  // repair candidate—not proof that message/card delivery finished.
  if (seoArtifactOutboxEnabled()) return null

  // Rollback dual-read: old code can still display either an already-keyed
  // artifact or the legacy title-based row; no new-schema write is required.
  if (!db.agentArtifact?.findUnique) return null
  const byKey = await db.agentArtifact.findUnique({ where: { deliveryKey: artifactDeliveryKey(input.actionId) } }).catch(() => null)
  if (byKey) return {
    id: byKey.id,
    title: byKey.title ?? 'SEO অডিট রিপোর্ট',
    type: byKey.type ?? 'html',
    version: byKey.version,
  }

  if (!input.conversationId) return null
  const action = await db.agentPendingAction.findUnique({ where: { id: input.actionId }, select: { payload: true } })
  const url = String((action?.payload as Record<string, unknown> | null)?.url ?? '')
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } })()
  if (!host) return null
  const legacy = await db.agentArtifact.findFirst({
    where: { conversationId: input.conversationId, title: `SEO অডিট ড্যাশবোর্ড — ${host}` },
    orderBy: { createdAt: 'desc' },
  })
  return legacy ? {
    id: legacy.id,
    title: legacy.title ?? `SEO অডিট ড্যাশবোর্ড — ${host}`,
    type: legacy.type ?? 'html',
    version: legacy.version,
  } : null
}

export async function runSeoArtifactDeliverySweep(limit = 2, options: { deadlineAt?: number } = {}): Promise<{
  scanned: number
  delivered: number
  retried: number
  dead: number
  repaired: number
}> {
  if (!seoArtifactOutboxEnabled()) return { scanned: 0, delivered: 0, retried: 0, dead: 0, repaired: 0 }
  const repair = await repairMissingSeoArtifactOutboxes(Math.min(limit, 4))
  const now = new Date()
  const rows = await db.agentArtifactDeliveryOutbox.findMany({
    where: {
      OR: [
        { status: { in: ['pending', 'retry'] }, availableAt: { lte: now } },
        { status: 'processing', leaseUntil: { lt: now } },
      ],
    },
    orderBy: { availableAt: 'asc' },
    take: Math.max(1, Math.min(limit, 100)),
    select: { sourceId: true },
  })
  const result = { scanned: rows.length, delivered: 0, retried: 0, dead: 0, repaired: repair.enqueued }
  for (const row of rows) {
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) break
    const outcome = await dispatchSeoArtifactDeliveryForAction(row.sourceId)
    if (outcome.status === 'delivered') result.delivered++
    else if (outcome.status === 'dead') result.dead++
    else if (outcome.status === 'retry') result.retried++
  }
  return result
}
