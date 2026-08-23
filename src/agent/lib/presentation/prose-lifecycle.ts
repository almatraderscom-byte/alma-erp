/**
 * Prose lifecycle v2 — typed, ID-addressable owner prose for one agent turn.
 *
 * Incident 2026-08-22 (handoff F-01…F-04): the runner speaks a short owner
 * update every two tool steps, but the clients and the canonical projection
 * still implemented the older "one settled reply per turn" contract — every
 * `tool_start` wiped the visible prose on iOS/web, and the settled projection
 * kept only the opening line plus the last text. Tool calls survived because
 * they have durable identity; prose had none.
 *
 * This module gives prose the same identity:
 *
 *   - a TRACKER derives explicit blocks (lead / progress / draft / final) from
 *     the runner's existing event stream plus a single anchor hook at the
 *     timeline push sites, so the runner's 30+ emission sites stay untouched;
 *   - for a turn negotiated as protocol 2 the tracker rewrites the wire into the
 *     typed family (`prose_start` / `text_delta{blockId}` / `prose_commit` /
 *     `prose_supersede`) and never emits `verification_retry`;
 *   - for protocol 1 every event passes through byte-identical — the old
 *     destructive client reducers stay scoped to the old wire;
 *   - the terminal message stores ONE authoritative block document
 *     (`usage.presentationV2`) written in the same insert as the message.
 *
 * Pure and synchronous — unit-tested with the shared fixture under
 * src/agent/protocol/fixtures/prose-lifecycle-v2/.
 */

export const PROSE_PROTOCOL_V1 = 1 as const
export const PROSE_PROTOCOL_V2 = 2 as const
export type ProseProtocol = 1 | 2

export type ProseKind = 'lead' | 'progress' | 'draft' | 'final'
export type ProseBlockState = 'streaming' | 'committed' | 'superseded'

/** Loose wire event — the tracker only inspects `type` and a few fields. */
export type WireEvent = { type: string; [k: string]: unknown }

export interface PresentationV2DocumentBlock {
  id: string
  kind: ProseKind
  state: 'committed' | 'superseded'
  revision: number
  text: string
  /** Index of this block's `{t:'text'}` entry in usage.timeline (chronology anchor). */
  timelineIndex?: number
  /** Block this one replaced (verification / contract rewrite). */
  replaces?: string
  /** Why a superseded block was retired. */
  reason?: string
}

/**
 * The ONE durable authority for a settled v2 transcript. Lives in
 * `AgentMessage.usage.presentationV2`, written atomically with the message row.
 * Raw `content` and `usage.timeline` stay audit material and model history.
 */
export interface PresentationV2Document {
  version: 2
  /** Wire protocol the turn streamed with (a v1 turn still gets a document). */
  protocol: ProseProtocol
  turnId: string | null
  messageId: string
  blocks: PresentationV2DocumentBlock[]
  /** Privacy-safe parity fingerprint: ordered visible `id:kind`, hashed. */
  fingerprint: string
}

export const PRESENTATION_V2_USAGE_KEY = 'presentationV2'

/** FNV-1a 32-bit, hex — tiny, dependency-free, stable across JS/Swift. */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Fingerprint over ORDERED visible blocks — ids and kinds only, never prose. */
export function proseFingerprint(blocks: Array<{ id: string; kind: string }>): string {
  return fnv1aHex(blocks.map((b) => `${b.id}:${b.kind}`).join('|'))
}

// ── Negotiation ────────────────────────────────────────────────────────────

/**
 * One protocol per turn, chosen from what the CLIENT advertises and what this
 * server can honour. Nothing is ever inferred from individual events.
 *
 *  - `AGENT_PROSE_PROTOCOL_V2=off` is the rollback lever: every turn streams v1.
 *  - The native Anthropic loop (kill-switch path) is v1-only.
 *  - Voice turns keep the buffered whole-round emission (spoken audio cannot be
 *    retracted), so they stay on v1 where that contract is already proven.
 */
export function negotiateProseProtocol(input: {
  requested: unknown
  voiceTurn?: boolean
  env?: Record<string, string | undefined>
}): ProseProtocol {
  const env = input.env ?? process.env
  const flag = (env.AGENT_PROSE_PROTOCOL_V2 ?? '').trim().toLowerCase()
  if (flag === 'off' || flag === 'false' || flag === '0') return PROSE_PROTOCOL_V1
  if (env.AGENT_NATIVE_ANTHROPIC_LOOP === 'true') return PROSE_PROTOCOL_V1
  if (input.voiceTurn) return PROSE_PROTOCOL_V1
  const n = typeof input.requested === 'number' ? input.requested : Number(input.requested)
  return Number.isFinite(n) && n >= 2 ? PROSE_PROTOCOL_V2 : PROSE_PROTOCOL_V1
}

/** Read the protocol a turn was negotiated with from `AgentTurn.versions`. */
export function proseProtocolFromVersions(versions: unknown): ProseProtocol {
  if (!versions || typeof versions !== 'object') return PROSE_PROTOCOL_V1
  const v = (versions as Record<string, unknown>).agentProseProtocol
  return v === 2 ? PROSE_PROTOCOL_V2 : PROSE_PROTOCOL_V1
}

// ── Tracker ────────────────────────────────────────────────────────────────

interface TrackerBlock {
  id: string
  kind: ProseKind
  state: ProseBlockState
  revision: number
  text: string
  timelineIndex?: number
  replaces?: string
  replacedBy?: string
  reason?: string
  /** Committed at a tool_start boundary; the round-end tail may still append. */
  continuable: boolean
  /** Appended to after a commit — the next boundary re-commits it. */
  dirty: boolean
  /** Superseded with a replacement promised; stays visible until it commits. */
  awaitingReplacement: boolean
}

/** Events that definitively end the open prose segment. */
const HARD_BOUNDARY_TYPES = new Set([
  'tool_end',
  'ask_card',
  'confirm_card',
  'artifact_saved',
  'subagent_start',
  'subagent_end',
  'steering_delivered',
  'model_switch_required',
  'conversation_compacted',
  'error',
])

/** Verifier categories whose rewrite must also retire the spoken opening line. */
const LEAD_RETIRING_CATEGORIES = new Set(['media_playback_unverified'])

const SUPERSEDED_TEXT_CAP = 2000

export class ProseLifecycleTracker {
  readonly protocol: ProseProtocol
  readonly turnId: string | null
  private readonly idPrefix: string
  private blocks: TrackerBlock[] = []
  private open: TrackerBlock | null = null
  private pendingReplacement: { target: TrackerBlock; id: string } | null = null
  private reservedAnchor: number | null = null
  private seq = 0
  private settled = false
  private queued: WireEvent[] = []
  private broken = false

  constructor(opts: { protocol: ProseProtocol; turnId?: string | null; idSeed?: string }) {
    this.protocol = opts.protocol
    this.turnId = opts.turnId ?? null
    this.idPrefix = opts.turnId ?? opts.idSeed ?? 'turn'
  }

  // ── runner-facing ──────────────────────────────────────────────────────

  /**
   * Call right BEFORE `timeline.push({ t: 'text', … })` with the index the entry
   * will get. Anchors the block currently receiving prose (or the next one to
   * open) to that timeline position, so the settled projection can interleave
   * prose with activity in true chronology — even when the raw timeline is
   * later truncated.
   */
  anchorTimeline(index: number): void {
    const current = this.open ?? this.continuableBlock()
    if (current && current.timelineIndex == null) {
      current.timelineIndex = index
      return
    }
    // Nothing open, or the open block already has its place: the entry being
    // pushed belongs to the NEXT block to open (a rewrite / harness line).
    this.reservedAnchor = index
  }

  /** The authoritative block document for the terminal message write. */
  document(messageId: string): PresentationV2Document {
    this.settle()
    const blocks: PresentationV2DocumentBlock[] = this.blocks
      .filter((b) => b.state !== 'streaming')
      .map((b) => ({
        id: b.id,
        kind: b.kind,
        state: b.state === 'superseded' ? 'superseded' : 'committed',
        revision: b.revision,
        text: b.state === 'superseded' ? b.text.slice(0, SUPERSEDED_TEXT_CAP) : b.text,
        ...(b.timelineIndex != null ? { timelineIndex: b.timelineIndex } : {}),
        ...(b.replaces ? { replaces: b.replaces } : {}),
        ...(b.reason ? { reason: b.reason } : {}),
      }))
    return {
      version: 2,
      protocol: this.protocol,
      turnId: this.turnId,
      messageId,
      blocks,
      fingerprint: proseFingerprint(visibleDocumentBlocks(blocks)),
    }
  }

  /** Owner-visible prose in order (lead, progress…, final), for previews. */
  ownerVisibleText(): string {
    return this.visibleBlocks()
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n\n')
  }

  /** Ordered visible blocks (ids + kinds) — the live side of the parity check. */
  visibleBlocks(): Array<{ id: string; kind: ProseKind; text: string }> {
    return this.blocks
      .filter((b) => b.text.trim() && (b.state !== 'superseded' || b.awaitingReplacement))
      // A replacement stays off-screen until it commits (the target is still shown).
      .filter((b) => !(b.state === 'streaming' && b.replaces))
      .map((b) => ({ id: b.id, kind: b.kind, text: b.text }))
  }

  /**
   * Error salvage (Codex P1 #834 r3). When a provider fails mid-turn the runner
   * persists `text` — the partial prose plus a synthesized failure / continue
   * warning (or a gate's replacement text) — as the message content. This
   * document is the read-time authority over that content, so it must say the
   * same thing: otherwise the polled / cold view shows the partial work, or a
   * tool-only turn with no prose at all, as a clean success.
   *
   * `suffix` is the warning the runner appended. When `text` is exactly the
   * visible prose plus that suffix, the suffix becomes its own final block and
   * the streamed blocks keep their ids (live/cold parity for what streamed).
   * Any other `text` retires the visible blocks (reason 'salvage') and becomes
   * the single final block — the content wins, never the stale blocks.
   *
   * The wire events for the change (supersedes, then start + commit of the new
   * block) are QUEUED, not returned: these paths end with an `error`, not a
   * `done`, so nothing would drain them. The runner / route emits
   * `drainQueued()` before the terminal event, and the live reducers land on
   * exactly the transcript a reload shows (Codex P1 #834 r4).
   */
  salvage(text: string, opts?: { suffix?: string }): void {
    const wanted = text.trim()
    if (!wanted) return
    this.settle()
    const visible = this.ownerVisibleText().trim()
    if (wanted === visible) return
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
    const suffix = opts?.suffix?.trim() ?? ''
    let extra = wanted
    const extendsVisible =
      visible.length > 0
      && suffix.length > 0
      && wanted.endsWith(suffix)
      && normalize(wanted.slice(0, wanted.length - suffix.length)) === normalize(visible)
    const out: WireEvent[] = []
    if (extendsVisible) {
      extra = suffix
    } else {
      for (const b of this.blocks) {
        if (b.state === 'superseded' && !b.awaitingReplacement) continue
        out.push(...this.supersede(b, 'salvage', false))
      }
    }
    const block: TrackerBlock = {
      id: this.nextId(),
      kind: 'final',
      state: 'committed',
      revision: 1,
      text: extra,
      continuable: false,
      dirty: false,
      awaitingReplacement: false,
    }
    this.blocks.push(block)
    out.push(...this.v2([
      { type: 'prose_start', blockId: block.id, kind: 'final', revision: 1 },
      { type: 'prose_commit', blockId: block.id, kind: 'final', revision: 1, text: extra, checksum: fnv1aHex(extra) },
    ]))
    this.queued.push(...out)
  }

  /**
   * Lifecycle events queued by `settle()` / `salvage()` on a path that will NOT
   * end with `done` (the runner yields them, or the route emits them, right
   * before the terminal `error`). Empty for a v1 turn.
   */
  drainQueued(): WireEvent[] {
    const out = this.queued
    this.queued = []
    return out
  }

  // ── interceptor-facing ─────────────────────────────────────────────────

  /** Derive lifecycle state from one runner event; return what to forward. */
  process(event: WireEvent): WireEvent[] {
    if (this.broken) return [event]
    try {
      return this.processUnsafe(event)
    } catch (err) {
      // Never let bookkeeping kill a live turn. Fall back to pass-through; a
      // v2 client then sees plain v1 deltas, which it treats as a draft lane.
      this.broken = true
      console.warn('[prose-lifecycle] tracker failed — passing events through:', err instanceof Error ? err.message : err)
      return [event]
    }
  }

  private processUnsafe(event: WireEvent): WireEvent[] {
    switch (event.type) {
      case 'text_delta':
        return this.onTextDelta(event)
      case 'preamble':
        return [...this.onPreamble(event), event]
      case 'tool_start':
        return [...this.onToolStart(), event]
      case 'progress_update':
        return [...this.onProgressUpdate(event), event]
      case 'verification_retry':
        return this.onVerificationRetry(event)
      case 'prospective_plan_start':
        return [...this.onProspectivePlanStart(), event]
      case 'done':
        return [...this.onDone(), event]
      default:
        if (HARD_BOUNDARY_TYPES.has(event.type)) return [...this.hardBoundary(), event]
        return [event]
    }
  }

  // ── state machine ──────────────────────────────────────────────────────

  private nextId(): string {
    this.seq += 1
    return `${this.idPrefix}:p${this.seq}`
  }

  private v2(events: WireEvent[]): WireEvent[] {
    return this.protocol === PROSE_PROTOCOL_V2 ? events : []
  }

  private continuableBlock(): TrackerBlock | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.continuable && b.state === 'committed') return b
    }
    return null
  }

  private lastVisibleNonLead(): TrackerBlock | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.kind === 'lead') continue
      if (b.state === 'superseded') continue
      return b
    }
    return null
  }

  private openBlock(): { block: TrackerBlock; events: WireEvent[] } {
    const pending = this.pendingReplacement
    const id = pending?.id ?? this.nextId()
    const block: TrackerBlock = {
      id,
      kind: 'draft',
      state: 'streaming',
      revision: 1,
      text: '',
      continuable: false,
      dirty: false,
      awaitingReplacement: false,
    }
    if (pending) {
      block.replaces = pending.target.id
      pending.target.replacedBy = id
      this.pendingReplacement = null
    }
    // A replacement is NOT anchored where its target was: the runner pushes the
    // rewrite's own timeline entry after the verify row, and the settled view
    // must read "…draft → যাচাই → final", never "final → যাচাই".
    if (this.reservedAnchor != null) block.timelineIndex = this.reservedAnchor
    this.reservedAnchor = null
    this.blocks.push(block)
    this.open = block
    const start: WireEvent = {
      type: 'prose_start',
      blockId: id,
      kind: 'draft',
      revision: 1,
      ...(block.replaces ? { replaces: block.replaces } : {}),
    }
    return { block, events: this.v2([start]) }
  }

  private commit(block: TrackerBlock, kind: Exclude<ProseKind, 'draft'>): WireEvent[] {
    if (block.state === 'superseded') return []
    if (this.open === block) this.open = null
    if (!block.text.trim()) {
      // An opened block that never received prose: retire it so a v2 client does
      // not keep an empty streaming block (and its fingerprint stays in parity).
      block.state = 'superseded'
      block.reason = 'empty'
      block.continuable = false
      return this.v2([{ type: 'prose_supersede', blockId: block.id, reason: 'empty' }])
    }
    if (block.state === 'committed') {
      if (!block.dirty && block.kind === kind) return []
      block.revision += 1
    }
    block.state = 'committed'
    block.kind = kind
    block.dirty = false
    block.continuable = false
    // A committed replacement retires the whole chain it replaced: the target
    // stayed visible only until this moment.
    let replaced = block.replaces ? this.blocks.find((b) => b.id === block.replaces) : undefined
    while (replaced) {
      replaced.awaitingReplacement = false
      replaced = replaced.replaces ? this.blocks.find((b) => b.id === replaced!.replaces) : undefined
    }
    return this.v2([
      {
        type: 'prose_commit',
        blockId: block.id,
        kind,
        revision: block.revision,
        text: block.text,
        checksum: fnv1aHex(block.text),
      },
    ])
  }

  private supersede(block: TrackerBlock, reason: string, withReplacement: boolean): WireEvent[] {
    if (block.state === 'superseded' && !block.awaitingReplacement) return []
    if (this.open === block) this.open = null
    block.state = 'superseded'
    block.reason = reason
    block.continuable = false
    block.dirty = false
    if (withReplacement) {
      const id = this.nextId()
      block.awaitingReplacement = true
      block.replacedBy = id
      this.pendingReplacement = { target: block, id }
      return this.v2([{ type: 'prose_supersede', blockId: block.id, replacementBlockId: id, reason }])
    }
    block.awaitingReplacement = false
    return this.v2([{ type: 'prose_supersede', blockId: block.id, reason }])
  }

  private onTextDelta(event: WireEvent): WireEvent[] {
    const raw = typeof event.delta === 'string' ? event.delta : ''
    if (!raw) return this.protocol === PROSE_PROTOCOL_V2 ? [] : [event]
    const out: WireEvent[] = []
    let block = this.open
    if (!block) {
      const cont = this.continuableBlock()
      if (cont) {
        block = cont
        this.open = cont
      } else {
        const opened = this.openBlock()
        block = opened.block
        out.push(...opened.events)
      }
    }
    // The runner prefixes a paragraph separator to a NEW segment's first delta
    // ("\n\n" between rounds). Inside an addressed block that is noise.
    const delta = block.text.length === 0 ? raw.replace(/^\s+/, '') : raw
    if (this.protocol !== PROSE_PROTOCOL_V2) {
      block.text += delta
      if (block.state === 'committed') block.dirty = true
      return [event]
    }
    if (!delta) return out
    block.text += delta
    if (block.state === 'committed') block.dirty = true
    out.push({ ...event, delta, blockId: block.id, revision: block.revision })
    return out
  }

  private onPreamble(event: WireEvent): WireEvent[] {
    const block = this.open ?? this.blocks[this.blocks.length - 1] ?? null
    if (!block || block.state === 'superseded') return []
    // A server notice (model OFF / worker-only redirect) streams into the open
    // block BEFORE the delegated runner speaks its lead. Committing both as one
    // `lead` put the notice after the preamble-thinking row on reload while the
    // live view showed it first (Codex P1 #834 r6): split them — the notice is
    // its own progress block, the preamble text alone is the lead.
    const preambleText = typeof event.text === 'string' ? event.text.trim() : ''
    const cut = preambleText ? block.text.lastIndexOf(preambleText) : -1
    if (preambleText && cut > 0 && block.text.slice(0, cut).trim()) {
      const out: WireEvent[] = []
      block.text = block.text.slice(0, cut)
      block.dirty = true
      out.push(...this.commit(block, 'progress'))
      const { block: lead, events } = this.openBlock()
      lead.text = preambleText
      out.push(...events)
      out.push(...this.commit(lead, 'lead'))
      return out
    }
    return this.commit(block, 'lead')
  }

  private onToolStart(): WireEvent[] {
    const block = this.open
    if (!block) return []
    const events = this.commit(block, 'progress')
    if (block.state === 'committed') block.continuable = true
    return events
  }

  private onProgressUpdate(event: WireEvent): WireEvent[] {
    // A new provider round is a hard segment boundary (the forced tool-free
    // update and the next round's narration must never merge into one block).
    if (event.stage === 'round') return this.hardBoundary()
    return []
  }

  private hardBoundary(): WireEvent[] {
    const out: WireEvent[] = []
    if (this.open) out.push(...this.commit(this.open, 'progress'))
    for (const b of this.blocks) b.continuable = false
    // A promised replacement survives tool rounds: the verifier's rewrite is
    // usually written in the NEXT provider round, after a round boundary. Only
    // terminal settlement or an explicit plan reset cancels the promise.
    return out
  }

  private onVerificationRetry(event: WireEvent): WireEvent[] {
    const categories = Array.isArray(event.categories)
      ? (event.categories as unknown[]).filter((c): c is string => typeof c === 'string')
      : []
    const reason = categories.length > 0 ? categories.join(',') : 'rewrite'
    const passthrough = this.protocol === PROSE_PROTOCOL_V2 ? [] : [event]
    const retireLead = categories.some((c) => LEAD_RETIRING_CATEGORIES.has(c))
    const out: WireEvent[] = []
    if (retireLead) {
      const visible = this.blocks.filter((b) => b.state !== 'superseded' || b.awaitingReplacement)
      if (visible.length === 0) return passthrough
      this.pendingReplacement = null
      visible.forEach((b, i) => {
        out.push(...this.supersede(b, reason, i === visible.length - 1))
      })
      return [...out, ...passthrough]
    }
    const target = this.open ?? this.continuableBlock() ?? this.lastVisibleNonLead()
    if (!target) {
      // Nothing visible to retire, but a replacement was announced: whatever
      // prose follows is the rewrite and must not inherit the old continuation.
      return passthrough
    }
    if (target.awaitingReplacement && this.pendingReplacement?.target === target) {
      // Repeated retry before the replacement even opened: the promise stands.
      return passthrough
    }
    out.push(...this.supersede(target, reason, true))
    return [...out, ...passthrough]
  }

  private onProspectivePlanStart(): WireEvent[] {
    const out: WireEvent[] = []
    this.pendingReplacement = null
    for (const b of this.blocks) {
      if (b.state === 'superseded' && !b.awaitingReplacement) continue
      out.push(...this.supersede(b, 'prospective_plan', false))
    }
    this.open = null
    return out
  }

  /** Terminal settlement — idempotent; shared by `document()` and `done`. */
  private settle(): WireEvent[] {
    if (this.settled) return []
    this.settled = true
    const out: WireEvent[] = []
    if (this.pendingReplacement) {
      const { target } = this.pendingReplacement
      this.pendingReplacement = null
      target.awaitingReplacement = false
      out.push(...this.v2([{ type: 'prose_supersede', blockId: target.id, reason: 'no_replacement' }]))
    }
    if (this.open) {
      out.push(...this.commit(this.open, 'final'))
    } else {
      const last = this.lastVisibleNonLead()
      if (last && last.state === 'committed' && last.kind === 'progress') {
        out.push(...this.commit(last, 'final'))
      }
    }
    for (const b of this.blocks) b.continuable = false
    this.queued.push(...out)
    return out
  }

  private onDone(): WireEvent[] {
    this.settle()
    const out = this.queued
    this.queued = []
    return out
  }
}

/** Which document blocks an owner actually sees (committed, non-empty). */
export function visibleDocumentBlocks(
  blocks: PresentationV2DocumentBlock[],
): PresentationV2DocumentBlock[] {
  return blocks.filter((b) => b.state === 'committed' && b.kind !== 'draft' && b.text.trim().length > 0)
}

/** Owner-visible prose from a stored document (lead, progress…, final). */
export function ownerVisibleTextFromDocument(doc: PresentationV2Document): string {
  return visibleDocumentBlocks(doc.blocks)
    .map((b) => b.text.trim())
    .join('\n\n')
}

/** Validate a stored `usage.presentationV2` value; null when absent/malformed. */
export function readPresentationV2Document(usage: unknown): PresentationV2Document | null {
  if (!usage || typeof usage !== 'object') return null
  const raw = (usage as Record<string, unknown>)[PRESENTATION_V2_USAGE_KEY]
  if (!raw || typeof raw !== 'object') return null
  const doc = raw as Record<string, unknown>
  if (doc.version !== 2 || !Array.isArray(doc.blocks)) return null
  const blocks: PresentationV2DocumentBlock[] = []
  for (const b of doc.blocks as unknown[]) {
    if (!b || typeof b !== 'object') continue
    const r = b as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.text !== 'string') continue
    const kind = r.kind
    const state = r.state
    if (kind !== 'lead' && kind !== 'progress' && kind !== 'draft' && kind !== 'final') continue
    if (state !== 'committed' && state !== 'superseded') continue
    blocks.push({
      id: r.id,
      kind,
      state,
      revision: typeof r.revision === 'number' ? r.revision : 1,
      text: r.text,
      ...(typeof r.timelineIndex === 'number' ? { timelineIndex: r.timelineIndex } : {}),
      ...(typeof r.replaces === 'string' ? { replaces: r.replaces } : {}),
      ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    })
  }
  return {
    version: 2,
    protocol: doc.protocol === 2 ? 2 : 1,
    turnId: typeof doc.turnId === 'string' ? doc.turnId : null,
    messageId: typeof doc.messageId === 'string' ? doc.messageId : '',
    blocks,
    fingerprint: typeof doc.fingerprint === 'string' ? doc.fingerprint : proseFingerprint(visibleDocumentBlocks(blocks)),
  }
}

// ── Interceptor ────────────────────────────────────────────────────────────

/**
 * Wrap the runner's event stream. Every event passes the tracker exactly once,
 * in order, BEFORE the runner resumes — so when the runner reaches its terminal
 * write, `tracker.document()` already reflects every event it yielded.
 */
export async function* withProseLifecycle<T extends WireEvent>(
  source: AsyncIterable<T>,
  tracker: ProseLifecycleTracker,
): AsyncGenerator<WireEvent, void, undefined> {
  for await (const event of source) {
    for (const out of tracker.process(event)) yield out
  }
}

// ── Mixed-version projection ───────────────────────────────────────────────

/**
 * Serve a deliberate v1 view of a v2 turn's durable events to a client that
 * did not negotiate v2 (old build resuming a turn another client started). The
 * stored log keeps the typed family; only this read-time view degrades.
 * Returns null for events the v1 family has no equivalent for.
 */
export function projectEventForProtocol(event: WireEvent, clientProtocol: ProseProtocol): WireEvent | null {
  if (clientProtocol >= PROSE_PROTOCOL_V2) return event
  switch (event.type) {
    case 'prose_start':
    case 'prose_commit':
    case 'turn_protocol':
      return null
    case 'prose_supersede': {
      const reason = typeof event.reason === 'string' && event.reason ? event.reason : ''
      return {
        type: 'verification_retry',
        attempt: 1,
        maxAttempts: 1,
        categories: reason && reason !== 'rewrite' ? reason.split(',') : [],
        snippets: [],
      }
    }
    case 'text_delta': {
      if (event.blockId == null && event.revision == null) return event
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { blockId: _b, revision: _r, ...rest } = event
      return rest
    }
    default:
      return event
  }
}
