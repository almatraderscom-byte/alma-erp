/**
 * Distilled memory layers — L2 (scenario) and L3 (persona).
 *
 * Owner-approved 2026-08-03, idea borrowed from TencentDB Agent Memory's L0→L3
 * ladder but rebuilt on our own Postgres so no extra service is introduced.
 *
 * The problem it solves: `agent_memory` holds flat facts ("L1"). Answering
 * "কীভাবে কাজ করি / কী পছন্দ করি না" from flat facts means dragging in a dozen
 * rows and letting the head re-derive the same picture every single turn — the
 * same tokens, paid again and again. So once a week the facts are distilled into:
 *
 *   L2 scenario — up to 3 topic blocks per scope ("Trading pricing", "স্টাফ রুটিন")
 *   L3 persona  — ONE standing block per scope: how the owner works, what he
 *                 refuses, what he always wants.
 *
 * At retrieval time the persona block goes in first (always, no similarity gate —
 * it is short and always relevant) and the best-matching scenario block follows
 * if it clears the threshold. Both are subject to the digest budget, so the
 * layers can never crowd out the facts.
 *
 * DERIVED DATA ONLY. Every row is rebuilt from `agent_memory`; nothing is ever
 * authored here. Deleting the table costs nothing but a rebuild.
 */
import { createHash, randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'
import { agentSmartText } from '@/agent/lib/llm-text'
import { DIGEST_MAX_ITEMS, DIGEST_MAX_TOTAL_CHARS, applyMemoryBudget } from '@/agent/lib/memory-budget'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Below this many source facts a distillation says more about the model than the owner. */
export const MIN_SOURCE_FACTS = 8
/** Facts fed into one distillation pass. */
const SOURCE_FACT_LIMIT = 60
/** Ceilings the prompt asks for AND the parser enforces. */
export const MAX_SCENARIOS = 3
export const MAX_PERSONA_CHARS = 600
export const MAX_SCENARIO_CHARS = 500
export const MAX_TOPIC_CHARS = 40
/** An L2 block must actually match the turn; the persona block is exempt. */
const L2_SIMILARITY_THRESHOLD = 0.35
/**
 * A block older than this stops being injected (Codex P1, PR #711).
 *
 * The weekly job is the only thing that refreshes these rows. If it ever stops —
 * cron disabled, route broken, model failing — the digests would otherwise keep
 * describing a business that has moved on, with nothing to signal it. Five weeks
 * tolerates a few missed runs and then falls silent, which is the safe direction:
 * the facts themselves are still retrieved.
 */
const DIGEST_MAX_AGE_DAYS = 35

/**
 * A digest may only speak while every fact it was built from is still true.
 *
 * Codex P1 rounds 2–3 (PR #711). Round 2 established that a weekly rebuild is
 * too slow: a deletion on any other day left the blocks quoting facts that no
 * longer existed. Round 3 found the hole in the first fix — checking that each
 * source ID still EXISTS says nothing about whether its content changed, and
 * keyed saves (`createOrUpdateAgentMemory`, `update_memory`, owner corrections)
 * rewrite a row in place while keeping its id.
 *
 * So the check is on CONTENT, not identity: each source is stored with an md5 of
 * the text it was distilled from, and a block serves only while every source
 * still hashes the same and has not expired. Postgres `md5()` and Node's md5
 * agree byte for byte, so the comparison is exact.
 *
 * Content hashing rather than `updatedAt <= refreshed_at` on purpose: a row whose
 * importance or expiry was merely refreshed — which happens whenever the head
 * re-saves an identical observation — bumps the timestamp without changing what
 * the summary said. Timestamps would retire a perfectly correct block; hashes
 * only fire when the words actually changed.
 *
 * Strict: ONE changed, deleted or expired source retires the block until the
 * weekly rebuild. A summary that misquotes the owner is worse than no summary,
 * and the underlying facts are still retrieved either way.
 */
function sourcesStillLive(scope: 'personal' | 'business', businessId: AgentBusinessId | null): string {
  // The source must still belong to THIS slot (Codex P2, PR #711 round 9).
  // `createOrUpdateAgentMemory` matches an existing row by scope+key alone, so
  // saving the same key from the other business rewrites that row's businessId
  // while leaving its text — and therefore its hash — untouched. Membership is
  // re-checked here with the same predicate the build used, so a fact that
  // changed sides stops validating the digest it used to belong to.
  const membership =
    scope === 'personal'
      ? `m.scope = 'personal'`
      : businessId === 'ALMA_TRADING'
        ? `m.scope != 'personal' AND m.metadata->>'businessId' = 'ALMA_TRADING'`
        : `m.scope != 'personal' AND (m.metadata->>'businessId' IS NULL OR m.metadata->>'businessId' = 'ALMA_LIFESTYLE')`

  return `AND (
       d.source_ids IS NULL
       OR (SELECT count(*)
           FROM jsonb_to_recordset(d.source_ids) AS s(id text, h text)
           JOIN agent_memory m ON m.id = s.id
           WHERE md5(m.content) = s.h
             AND (m.expires_at IS NULL OR m.expires_at > NOW())
             AND (${membership}))
          = jsonb_array_length(d.source_ids)
     )`
}

export interface DigestTarget {
  scope: 'personal' | 'business'
  businessId: AgentBusinessId | null
}

/** Every digest slot we maintain: personal, plus one per business. */
export const DIGEST_TARGETS: DigestTarget[] = [
  { scope: 'personal', businessId: null },
  { scope: 'business', businessId: 'ALMA_LIFESTYLE' },
  { scope: 'business', businessId: 'ALMA_TRADING' },
]

const DISTILL_SYSTEM = `তুমি ALMA-র ব্যক্তিগত এজেন্টের স্মৃতি-সংক্ষেপক।
তোমাকে বসের সম্পর্কে সংরক্ষিত কিছু আলাদা আলাদা তথ্য (fact) দেওয়া হবে। সেগুলো থেকে দুই ধরনের সারাংশ বানাবে:

1. persona — বস কীভাবে কাজ করেন, কী পছন্দ/অপছন্দ করেন, কোন নিয়মগুলো সবসময় প্রযোজ্য। স্থায়ী প্যাটার্ন, একদিনের ঘটনা নয়।
2. scenarios — সর্বোচ্চ ৩টি বিষয়ভিত্তিক ব্লক (যেমন দাম নির্ধারণ, স্টাফ, অর্ডার, খরচ)। প্রতিটিতে ওই বিষয়ের বর্তমান অবস্থা এক জায়গায়।

কঠিন নিয়ম:
- শুধু দেওয়া তথ্য থেকেই লিখবে। কিছু আবিষ্কার করবে না, অনুমান করবে না।
- পুরোটা বাংলায়। বসকে "Boss" বলবে, "Sir"/"স্যার" কখনো নয়। কোনো ইমোজি নয়।
- persona সর্বোচ্চ ${MAX_PERSONA_CHARS} অক্ষর; প্রতিটি scenario summary সর্বোচ্চ ${MAX_SCENARIO_CHARS} অক্ষর; topic সর্বোচ্চ ${MAX_TOPIC_CHARS} অক্ষর।
- একদিনের ঘটনা (আজকের ছুটি, একদিনের নামাজের লগ) বাদ দেবে — এগুলো স্থায়ী নয়।
- যথেষ্ট প্যাটার্ন না থাকলে খালি ফল দেবে।

শুধু JSON আউটপুট, আর কিছু নয়:
{"persona":"...","scenarios":[{"topic":"...","summary":"..."}]}
যথেষ্ট তথ্য না থাকলে: {"persona":"","scenarios":[]}`

export interface DistilledDigest {
  persona: string
  scenarios: Array<{ topic: string; summary: string }>
}

/**
 * Parses + hard-caps the model's JSON. The prompt asks for the ceilings; this
 * enforces them, because a prompt is a request and a budget is a guarantee.
 */
export function parseDistilledDigest(raw: string): DistilledDigest {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { persona: '', scenarios: [] }
  let parsed: { persona?: unknown; scenarios?: unknown }
  try {
    parsed = JSON.parse(match[0]) as { persona?: unknown; scenarios?: unknown }
  } catch {
    return { persona: '', scenarios: [] }
  }

  const persona = String(parsed.persona ?? '').trim().slice(0, MAX_PERSONA_CHARS)
  const rawScenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios : []
  const scenarios: Array<{ topic: string; summary: string }> = []
  const seenTopics = new Set<string>()

  for (const entry of rawScenarios) {
    if (scenarios.length >= MAX_SCENARIOS) break
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { topic?: unknown; summary?: unknown }
    const topic = String(e.topic ?? '').trim().slice(0, MAX_TOPIC_CHARS)
    const summary = String(e.summary ?? '').trim().slice(0, MAX_SCENARIO_CHARS)
    if (!topic || summary.length < 20) continue
    const dedupeKey = topic.toLowerCase()
    if (seenTopics.has(dedupeKey)) continue
    seenTopics.add(dedupeKey)
    scenarios.push({ topic, summary })
  }

  return { persona: persona.length >= 20 ? persona : '', scenarios }
}

/** SQL fragment selecting the fact rows that belong to one digest target. */
function sourceClause(target: DigestTarget): string {
  if (target.scope === 'personal') return `scope = 'personal'`
  const businessFilter =
    target.businessId === 'ALMA_TRADING'
      ? `metadata->>'businessId' = 'ALMA_TRADING'`
      : `(metadata->>'businessId' IS NULL OR metadata->>'businessId' = 'ALMA_LIFESTYLE')`
  return `scope != 'personal' AND ${businessFilter}`
}

/**
 * Rolling data blobs are not standing facts.
 *
 * `business_snapshot` is one keyed row rewritten on every briefing — today's
 * numbers, not how the owner works. Distilling it into a persona block would be
 * wrong on the merits, and because its content changes daily it would also
 * retire the block within a day of every rebuild (Codex P1 round 3, PR #711).
 */
const VOLATILE_SOURCE_TYPES = ['business_snapshot']

async function loadSourceFacts(target: DigestTarget): Promise<Array<{ id: string; content: string; pinned: boolean }>> {
  const volatileList = VOLATILE_SOURCE_TYPES.map((t) => `'${t}'`).join(', ')
  return db.$queryRawUnsafe(
    `SELECT id, content, pinned
     FROM agent_memory
     WHERE ${sourceClause(target)}
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (metadata->>'type' IS NULL OR metadata->>'type' NOT IN (${volatileList}))
     ORDER BY pinned DESC, importance DESC, COALESCE(last_used_at, "createdAt") DESC
     LIMIT ${SOURCE_FACT_LIMIT}`,
  )
}

/** SQL fragment identifying one digest slot's rows (personal has a NULL business). */
function slotMatch(target: DigestTarget): string {
  return target.businessId === null ? `business_id IS NULL` : `business_id = '${target.businessId}'`
}

/**
 * Drops a slot's blocks without writing new ones.
 *
 * Needed when a scope no longer has enough facts to distill (Codex P1, PR #711):
 * the old blocks would otherwise survive forever, and since the persona block is
 * injected on every turn, facts the owner deliberately deleted in the weekly
 * revision would keep speaking from a summary. No facts, no summary.
 */
export async function clearDigestRows(target: DigestTarget): Promise<void> {
  await db.$executeRawUnsafe(
    `DELETE FROM agent_memory_digest WHERE scope = $1 AND ${slotMatch(target)}`,
    target.scope,
  )
}

/** What a block was distilled from: the row id plus a hash of its exact text. */
export interface SourceFingerprint {
  id: string
  h: string
}

/** md5 of the stored text — matches Postgres `md5(content)` byte for byte. */
export function fingerprintSources(
  facts: Array<{ id: string; content: string }>,
): SourceFingerprint[] {
  return facts.map((f) => ({ id: f.id, h: createHash('md5').update(f.content).digest('hex') }))
}

/** Replaces every stored block for one slot in a single transaction. */
async function writeDigestRows(
  target: DigestTarget,
  rows: Array<{ layer: 'L2' | 'L3'; topic: string; content: string; embedding: string | null }>,
  sources: SourceFingerprint[],
): Promise<void> {
  const businessId = target.businessId
  const businessMatch = slotMatch(target)

  const statements = [
    db.$executeRawUnsafe(
      `DELETE FROM agent_memory_digest WHERE scope = $1 AND ${businessMatch}`,
      target.scope,
    ),
    ...rows.map((row) =>
      db.$executeRawUnsafe(
        `INSERT INTO agent_memory_digest
           (id, layer, scope, business_id, topic, content, embedding, source_count, source_ids,
            refreshed_at, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9::jsonb, NOW(), NOW(), NOW())`,
        randomUUID(),
        row.layer,
        target.scope,
        businessId,
        row.topic,
        row.content,
        row.embedding,
        sources.length,
        JSON.stringify(sources.slice(0, SOURCE_FACT_LIMIT)),
      ),
    ),
  ]

  await db.$transaction(statements)
}

export interface DigestBuildResult {
  target: string
  sourceFacts: number
  personaWritten: boolean
  scenariosWritten: number
  skipped?: string
}

/** Rebuilds one slot's L2 + L3 blocks from its current facts. */
export async function buildDigestForTarget(target: DigestTarget): Promise<DigestBuildResult> {
  const label = target.businessId ? `${target.scope}:${target.businessId}` : target.scope
  const facts = await loadSourceFacts(target)
  if (facts.length < MIN_SOURCE_FACTS) {
    // The facts are gone — so must be any summary of them.
    await clearDigestRows(target)
    return { target: label, sourceFacts: facts.length, personaWritten: false, scenariosWritten: 0, skipped: 'too_few_facts' }
  }

  const raw = await agentSmartText({
    system: DISTILL_SYSTEM,
    prompt:
      `${target.scope === 'personal' ? 'ব্যক্তিগত' : `ব্যবসা (${target.businessId})`} স্মৃতি — ${facts.length}টি তথ্য:\n\n` +
      facts.map((f, i) => `${i + 1}. ${f.pinned ? '[স্থায়ী] ' : ''}${f.content.slice(0, 400)}`).join('\n'),
    maxTokens: 1400,
    costLabel: 'memory_digest',
  })

  const distilled = parseDistilledDigest(raw)
  if (!distilled.persona && distilled.scenarios.length === 0) {
    // Facts still exist — only this run produced nothing (a flaky or throttled
    // model call). The previous blocks are kept rather than thrown away, and the
    // freshness window above stops them from lingering if this keeps happening.
    return { target: label, sourceFacts: facts.length, personaWritten: false, scenariosWritten: 0, skipped: 'no_signal' }
  }

  const rows: Array<{ layer: 'L2' | 'L3'; topic: string; content: string; embedding: string | null }> = []

  if (distilled.persona) {
    // The persona block is retrieved unconditionally, so its embedding is optional.
    rows.push({ layer: 'L3', topic: 'persona', content: distilled.persona, embedding: null })
  }
  let anyEmbeddingFailed = false
  for (const scenario of distilled.scenarios) {
    // An L2 block IS matched by similarity, so a failed embedding means it can
    // never be retrieved — skip it rather than store a dead row.
    const embedded = await embed(`${scenario.topic}\n${scenario.summary}`)
    if (!embedded.success) {
      anyEmbeddingFailed = true
      console.warn(`[memory-digest] embedding failed for ${label}/${scenario.topic}: ${embedded.error}`)
      continue
    }
    rows.push({
      layer: 'L2',
      topic: scenario.topic,
      content: scenario.summary,
      embedding: vectorLiteral(embedded.data),
    })
  }

  // The replacement is ALL OR NOTHING (Codex P2, PR #711 rounds 7–8).
  //
  // `writeDigestRows` deletes the slot before inserting, so a partial result
  // silently destroys the L2 blocks whose embeddings happened to fail this run —
  // and a persona alone is enough to make `rows` non-empty, which is how the
  // first version of this guard was bypassed. An embedding outage is transient
  // (summaries are capped at 500 characters, so failures are network or cost
  // gate, never content), and a week-old-but-complete digest beats a fresh one
  // with holes in it. The 35-day freshness window bounds how long that can last.
  if (rows.length === 0 || anyEmbeddingFailed) {
    return { target: label, sourceFacts: facts.length, personaWritten: false, scenariosWritten: 0, skipped: 'embedding_failed' }
  }

  await writeDigestRows(target, rows, fingerprintSources(facts))

  return {
    target: label,
    sourceFacts: facts.length,
    personaWritten: rows.some((r) => r.layer === 'L3'),
    scenariosWritten: rows.filter((r) => r.layer === 'L2').length,
  }
}

/** Weekly entry point — rebuilds every slot, one failure never stops the rest. */
export async function runMemoryDigest(): Promise<{ results: DigestBuildResult[] }> {
  const results: DigestBuildResult[] = []
  for (const target of DIGEST_TARGETS) {
    try {
      results.push(await buildDigestForTarget(target))
    } catch (err) {
      const label = target.businessId ? `${target.scope}:${target.businessId}` : target.scope
      console.warn(`[memory-digest] build failed for ${label}:`, err instanceof Error ? err.message : err)
      results.push({ target: label, sourceFacts: 0, personaWritten: false, scenariosWritten: 0, skipped: 'error' })
    }
  }
  return { results }
}

export interface DigestHit {
  id: string
  layer: 'L2' | 'L3'
  topic: string
  content: string
  score: number
}

/**
 * Retrieval side: the standing persona block plus the best-matching scenario
 * block, inside the digest budget. Fails soft — if the table is missing (preview
 * database before the migration runs) the turn simply gets no digest.
 */
export async function retrieveMemoryDigests(opts: {
  /** pgvector literal of the turn's query embedding; omitted → persona only. */
  queryVector?: string
  personalMode: boolean
  businessId: AgentBusinessId
}): Promise<DigestHit[]> {
  const scope: 'personal' | 'business' = opts.personalMode ? 'personal' : 'business'
  const businessMatch = opts.personalMode ? `business_id IS NULL` : `business_id = $1`
  const businessParams = opts.personalMode ? [] : [opts.businessId]
  const sourcesLive = sourcesStillLive(scope, opts.personalMode ? null : opts.businessId)

  try {
    const personaRows: Array<{ id: string; topic: string; content: string }> = await db.$queryRawUnsafe(
      `SELECT d.id, d.topic, d.content
       FROM agent_memory_digest d
       WHERE d.layer = 'L3' AND d.scope = '${scope}' AND d.${businessMatch}
         AND d.refreshed_at > NOW() - INTERVAL '${DIGEST_MAX_AGE_DAYS} days'
         ${sourcesLive}
       ORDER BY d.refreshed_at DESC
       LIMIT 1`,
      ...businessParams,
    )

    const hits: DigestHit[] = personaRows.map((r) => ({
      id: r.id,
      layer: 'L3' as const,
      topic: r.topic,
      content: r.content,
      score: 1,
    }))

    if (opts.queryVector) {
      const vecParamIndex = businessParams.length + 1
      const scenarioRows: Array<{ id: string; topic: string; content: string; score: number }> =
        await db.$queryRawUnsafe(
          `SELECT d.id, d.topic, d.content, 1 - (d.embedding <=> $${vecParamIndex}::vector) AS score
           FROM agent_memory_digest d
           WHERE d.layer = 'L2' AND d.scope = '${scope}' AND d.${businessMatch}
             AND d.embedding IS NOT NULL
             AND d.refreshed_at > NOW() - INTERVAL '${DIGEST_MAX_AGE_DAYS} days'
             ${sourcesLive}
           ORDER BY d.embedding <=> $${vecParamIndex}::vector
           LIMIT 2`,
          ...businessParams,
          opts.queryVector,
        )
      for (const row of scenarioRows) {
        if (row.score < L2_SIMILARITY_THRESHOLD) continue
        hits.push({ id: row.id, layer: 'L2', topic: row.topic, content: row.content, score: row.score })
      }
    }

    const budgeted = applyMemoryBudget(
      hits.map((h) => ({ ...h, content: `[${h.layer === 'L3' ? 'বসের ধরন' : h.topic}] ${h.content}` })),
      { maxItems: DIGEST_MAX_ITEMS, maxTotalChars: DIGEST_MAX_TOTAL_CHARS, maxItemChars: DIGEST_MAX_TOTAL_CHARS },
    )
    return budgeted.kept
  } catch (err) {
    console.warn('[memory-digest] retrieval skipped:', err instanceof Error ? err.message : err)
    return []
  }
}
