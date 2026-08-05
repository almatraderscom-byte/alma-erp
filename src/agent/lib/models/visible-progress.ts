/**
 * Provider-independent, owner-visible progress.
 *
 * This is deliberately NOT a synthetic chain-of-thought. Some providers expose
 * a reasoning stream and some (notably tool-bearing raw OpenAI requests) do not.
 * The harness can still report facts it directly observes: a model round began,
 * a concrete tool was selected, or answer text started arriving. Those facts are
 * useful on every model and never pretend to reveal private reasoning.
 */

export interface ProgressUpdateEvent {
  type: 'progress_update'
  label: string
}
const BN_DIGITS = '০১২৩৪৫৬৭৮৯'

function bn(n: number): string {
  return String(Math.max(1, Math.floor(n))).replace(/\d/g, (d) => BN_DIGITS[Number(d)])
}

function cleanLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, 180)
}

/**
 * One turn-scoped contract. Duplicate lifecycle notifications are suppressed so
 * provider adapters that announce a tool before its parsed input is available do
 * not create two identical rows in the process lane.
 */
export function createVisibleProgressContract(): {
  roundStarted(round: number): ProgressUpdateEvent
  toolSelected(round: number, toolLabel: string): ProgressUpdateEvent | null
  responseStarted(round: number): ProgressUpdateEvent | null
} {
  const emitted = new Set<string>()

  const once = (key: string, label: string): ProgressUpdateEvent | null => {
    if (emitted.has(key)) return null
    emitted.add(key)
    return { type: 'progress_update', label: cleanLabel(label) }
  }

  return {
    roundStarted(round) {
      // A request has actually been sent to the provider at this point. This says
      // nothing about what the model is privately thinking.
      return {
        type: 'progress_update',
        label: `ধাপ ${bn(round)} · পরের পদক্ষেপ প্রস্তুত হচ্ছে`,
      }
    },
    toolSelected(round, toolLabel) {
      const safe = cleanLabel(toolLabel)
      if (!safe) return null
      return once(`tool:${round}:${safe}`, `ধাপ ${bn(round)} · ${safe}`)
    },
    responseStarted(round) {
      return once(`response:${round}`, `ধাপ ${bn(round)} · ফল যাচাই করে উত্তর প্রস্তুত হচ্ছে`)
    },
  }
}
