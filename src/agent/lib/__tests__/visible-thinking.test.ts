/**
 * Plumbing out of the thought he watches.
 *
 * Every "should be removed" case below is a line he actually saw on screen while
 * comparing his agent's process pane to mine. A prompt rule against narrating
 * system instructions shipped first and the leak continued on the next turn —
 * which is why this is code.
 */
import { describe, expect, it } from 'vitest'
import { cleanVisibleThinking, createThinkingStreamFilter, isPlumbingThought } from '@/agent/lib/visible-thinking'

describe('lines that are about our machinery', () => {
  it('drops the ones he actually saw', () => {
    for (const line of [
      'The new human message is actually internal control notes, not a new Boss message.',
      'The mandatory first line rule still applies from the previous context.',
      'The verification failed because I asked a question in prose without using the ask_user tool.',
      'The internal control is reminding me that in the previous turn I announced a step.',
      'The find_tool returned no direct match for a general benchmark tool.',
    ]) {
      expect(isPlumbingThought(line), line).toBe(true)
    }
  })
})

describe('reasoning about HIS business is left alone', () => {
  it('keeps real thinking, in either language', () => {
    for (const line of [
      'expense summary এল — ১১০০৳, শুধু অন্যান্য খাতে; sales-এর সাথে মিলছে না।',
      'The catalog says 146 published products but the meta field is absent from this payload.',
      '৩১১টা SKU stock-এ আছে অথচ website-এ নেই — এটাই বড় ফাঁক।',
      'Little\'s Law would give 1 second here, but CPU needs service demand.',
    ]) {
      expect(isPlumbingThought(line), line).toBe(false)
    }
  })

  it('does not filter on language — English reasoning about the work survives', () => {
    const t = 'Ad spend is $27 over seven days with 2,600 clicks and zero orders.'
    expect(cleanVisibleThinking(t)).toBe(t)
  })
})

describe('cleaning a whole round', () => {
  it('removes only the plumbing lines and keeps the rest readable', () => {
    const raw = [
      'The new human message is actually internal control notes, not a new Boss message.',
      'catalog-এ ১৪৬টা product, meta ফিল্ড নেই।',
      'The verification failed because I asked a question in prose.',
      'তাহলে audit tool দিয়ে দেখতে হবে।',
    ].join('\n')
    const out = cleanVisibleThinking(raw)
    expect(out).toBe('catalog-এ ১৪৬টা product, meta ফিল্ড নেই।\nতাহলে audit tool দিয়ে দেখতে হবে।')
  })

  it('an all-plumbing round becomes empty — the honest outcome', () => {
    // That round contained no thinking he wanted to watch.
    const raw = [
      'The new human message is actually internal control notes.',
      'The mandatory first line rule still applies.',
    ].join('\n')
    expect(cleanVisibleThinking(raw)).toBe('')
  })
})

describe('the rule being ticked off — live customer-support turn, 2026-07-28', () => {
  it('drops the model reporting that it obeyed the first-line rule', () => {
    // This sentence WAS the whole visible thought of that turn.
    expect(cleanVisibleThinking('The first line has been outputted as required.')).toBe('')
    expect(cleanVisibleThinking('The mandatory first line was already emitted.')).toBe('')
  })

  it('still keeps real work that happens to mention a first line', () => {
    const real = 'পণ্যের description-এর প্রথম লাইনটাই দুর্বল — ওখানেই keyword বসাতে হবে।'
    expect(cleanVisibleThinking(real)).toBe(real)
    const english = 'The first line of the product description is weak, so the keyword goes there.'
    expect(cleanVisibleThinking(english)).toBe(english)
  })
})

describe('the live stream, not the stored copy — 2026-07-28', () => {
  const run = (deltas: string[]) => {
    const f = createThinkingStreamFilter()
    return deltas.map((d) => f.push(d)).join('') + f.flush()
  }

  it('never streams a plumbing line, even split across deltas', () => {
    // The exact line that was on his screen while the stored copy was clean.
    const out = run([
      'The response already ',
      'started with the mandatory first line as required.\n',
      'ক্যাটালগে ১৪৬টা product আছে।\n',
    ])

    expect(out).not.toContain('mandatory first line')
    expect(out).toContain('ক্যাটালগে ১৪৬টা product')
  })

  it('holds a line until it is complete — a half line cannot be judged', () => {
    const f = createThinkingStreamFilter()
    expect(f.push('The mandatory first ')).toBe('')
    expect(f.push('line rule still applies.')).toBe('')
    expect(f.flush()).toBe('')
  })

  it('strips markup out of the thought as well', () => {
    const out = run(['যাচাই করছি ', '<param', 'eter name="x">1</parameter>', '\n'])

    expect(out).not.toContain('parameter')
    expect(out).toContain('যাচাই করছি')
  })

  it('lets real reasoning through, line by line', () => {
    const out = run(['স্টক ৮টা।\n', 'তাহলে reorder লাগবে না।\n'])

    expect(out).toContain('স্টক ৮টা।')
    expect(out).toContain('তাহলে reorder লাগবে না।')
  })
})
