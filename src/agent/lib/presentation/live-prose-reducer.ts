/**
 * Client-side reducer for the protocol-2 prose family. Pure; shared by the web
 * client and the cross-layer fixture tests (the native Swift reducer mirrors
 * these rules one-for-one — the fixture keeps them in lockstep).
 *
 * Rules (handoff "canonical block states"):
 *   - every prose block is addressed by the server's `blockId`;
 *   - `tool_start` never touches prose;
 *   - a committed block is only ever changed by an event naming its id;
 *   - a superseded block with a promised replacement stays VISIBLE until that
 *     replacement commits, then the swap is atomic; without a replacement it is
 *     removed at once;
 *   - a replacement block is hidden while it streams.
 */
import { proseFingerprint, type ProseKind, type WireEvent } from './prose-lifecycle'

export interface LiveProseBlock {
  id: string
  kind: ProseKind
  state: 'streaming' | 'committed' | 'superseded'
  revision: number
  text: string
  /** Replacement still streaming — not rendered until its commit. */
  hidden: boolean
  /** Superseded, but its replacement has not committed yet — still rendered. */
  awaitingReplacement: boolean
  replaces?: string
}

export interface LiveProseState {
  blocks: LiveProseBlock[]
  /** replacementBlockId → superseded target id */
  pending: Record<string, string>
}

export function createLiveProseState(): LiveProseState {
  return { blocks: [], pending: {} }
}

export function isProseLifecycleEvent(type: string): boolean {
  return type === 'prose_start' || type === 'prose_commit' || type === 'prose_supersede' || type === 'text_delta'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function kindOf(v: unknown): ProseKind {
  return v === 'lead' || v === 'progress' || v === 'final' ? v : 'draft'
}

function clone(state: LiveProseState): LiveProseState {
  return { blocks: state.blocks.map((b) => ({ ...b })), pending: { ...state.pending } }
}

/**
 * The block a new replacement will stand in for ON SCREEN. A hidden
 * intermediate (a rewrite that was itself rewritten before it ever showed)
 * is skipped so the final replacement lands where the last visible block was.
 */
function replacementRoot(state: LiveProseState, targetId: string | undefined): string | undefined {
  let id = targetId
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    const b = state.blocks.find((x) => x.id === id)
    if (!b || !b.hidden) return id
    id = b.replaces
  }
  return id
}

/** Retire a superseded target and everything it replaced (chain). */
function retireChain(state: LiveProseState, targetId: string | undefined) {
  let id = targetId
  while (id) {
    const idx = state.blocks.findIndex((b) => b.id === id)
    if (idx < 0) break
    const next = state.blocks[idx].replaces
    state.blocks.splice(idx, 1)
    id = next
  }
}

/**
 * Apply one wire event. Events outside the prose family return the same state
 * object (cheap identity check for memoised renderers).
 */
export function applyProseEvent(state: LiveProseState, evt: WireEvent): LiveProseState {
  switch (evt.type) {
    case 'prose_start': {
      const id = str(evt.blockId)
      if (!id || state.blocks.some((b) => b.id === id)) return state
      const next = clone(state)
      const target = next.pending[id]
      const root = replacementRoot(next, target)
      next.blocks.push({
        id,
        kind: kindOf(evt.kind),
        state: 'streaming',
        revision: typeof evt.revision === 'number' ? evt.revision : 1,
        text: '',
        hidden: Boolean(target),
        awaitingReplacement: false,
        ...(root ? { replaces: root } : {}),
      })
      return next
    }
    case 'text_delta': {
      const id = str(evt.blockId)
      const delta = str(evt.delta) ?? ''
      if (!id || !delta) return state
      const next = clone(state)
      let block = next.blocks.find((b) => b.id === id)
      if (!block) {
        const target = next.pending[id]
        const root = replacementRoot(next, target)
        block = {
          id,
          kind: 'draft',
          state: 'streaming',
          revision: typeof evt.revision === 'number' ? evt.revision : 1,
          text: '',
          hidden: Boolean(target),
          awaitingReplacement: false,
          ...(root ? { replaces: root } : {}),
        }
        next.blocks.push(block)
      }
      block.text += delta
      return next
    }
    case 'prose_commit': {
      const id = str(evt.blockId)
      if (!id) return state
      const next = clone(state)
      let block = next.blocks.find((b) => b.id === id)
      const committedText = str(evt.text)
      if (!block) {
        const target = next.pending[id]
        const root = replacementRoot(next, target)
        block = {
          id,
          kind: 'draft',
          state: 'streaming',
          revision: 1,
          text: '',
          hidden: false,
          awaitingReplacement: false,
          ...(root ? { replaces: root } : {}),
        }
        next.blocks.push(block)
      }
      // Self-heal: the commit carries the full committed text, so a delta lost
      // on the wire cannot leave a truncated block on screen.
      if (committedText != null && committedText !== block.text) block.text = committedText
      block.state = 'committed'
      block.kind = kindOf(evt.kind)
      if (typeof evt.revision === 'number') block.revision = evt.revision
      block.hidden = false
      // Retire what this block stood in for: the promised target (possibly a
      // hidden intermediate) and, through the chain, the on-screen root.
      const pendingTarget = next.pending[id]
      delete next.pending[id]
      if (pendingTarget) retireChain(next, pendingTarget)
      if (block.replaces) retireChain(next, block.replaces)
      if (!block.text.trim()) {
        next.blocks = next.blocks.filter((b) => b.id !== id)
      }
      return next
    }
    case 'prose_supersede': {
      const id = str(evt.blockId)
      if (!id) return state
      const target = state.blocks.find((b) => b.id === id)
      if (!target) return state
      const next = clone(state)
      const replacementId = str(evt.replacementBlockId)
      const t = next.blocks.find((b) => b.id === id)!
      if (replacementId) {
        t.state = 'superseded'
        t.awaitingReplacement = true
        next.pending[replacementId] = id
        return next
      }
      // Removal: this block and whatever it was itself replacing.
      for (const key of Object.keys(next.pending)) if (next.pending[key] === id) delete next.pending[key]
      retireChain(next, id)
      return next
    }
    case 'done': {
      // Defensive settlement — the server commits before `done`, but a lost
      // commit must not leave a hidden replacement or a dangling promise.
      const next = clone(state)
      for (const b of next.blocks) {
        if (b.state === 'streaming' && !b.hidden) b.state = 'committed'
      }
      next.blocks = next.blocks.filter((b) => !(b.hidden && b.state === 'streaming'))
      next.blocks = next.blocks.filter((b) => !(b.state === 'superseded' && b.awaitingReplacement))
      next.pending = {}
      return next
    }
    default:
      return state
  }
}

/** Ordered blocks the owner sees right now. */
export function visibleProseBlocks(state: LiveProseState): LiveProseBlock[] {
  return state.blocks.filter(
    (b) => !b.hidden && b.text.trim().length > 0 && (b.state !== 'superseded' || b.awaitingReplacement),
  )
}

export function visibleProseText(state: LiveProseState): string {
  return visibleProseBlocks(state)
    .map((b) => b.text.trim())
    .join('\n\n')
}

/** Live side of the parity fingerprint (ids + kinds of visible blocks). */
export function liveProseFingerprint(state: LiveProseState): string {
  return proseFingerprint(visibleProseBlocks(state))
}
