import { describe, expect, it } from 'vitest'
import {
  MAX_PERSONA_CHARS,
  MAX_SCENARIOS,
  MAX_SCENARIO_CHARS,
  MAX_TOPIC_CHARS,
  parseDistilledDigest,
} from '@/agent/lib/memory-digest'

const persona = 'বস দাম নিয়ে আগে থেকে জানাতে বলেন, দেরি হলে সাথে সাথে জানাতে চান।'
const scenario = {
  topic: 'দাম নির্ধারণ',
  summary: 'ট্রেডিংয়ে কস্ট প্রাইস ছাড়া কোনো কোটেশন যায় না, মার্জিন সবসময় লিখিত অনুমোদনের পরে।',
}

describe('parseDistilledDigest', () => {
  it('parses a clean JSON response', () => {
    const out = parseDistilledDigest(JSON.stringify({ persona, scenarios: [scenario] }))
    expect(out.persona).toBe(persona)
    expect(out.scenarios).toEqual([scenario])
  })

  it('extracts JSON wrapped in prose or code fences', () => {
    const raw = `এই যে সারাংশ:\n\`\`\`json\n${JSON.stringify({ persona, scenarios: [] })}\n\`\`\`\nধন্যবাদ`
    expect(parseDistilledDigest(raw).persona).toBe(persona)
  })

  it('returns empty on non-JSON or malformed JSON instead of throwing', () => {
    expect(parseDistilledDigest('কোনো প্যাটার্ন পাইনি')).toEqual({ persona: '', scenarios: [] })
    expect(parseDistilledDigest('{"persona": broken,,}')).toEqual({ persona: '', scenarios: [] })
  })

  it('honours the model’s own empty result', () => {
    expect(parseDistilledDigest('{"persona":"","scenarios":[]}')).toEqual({ persona: '', scenarios: [] })
  })

  it('hard-caps persona length even when the model ignores the prompt', () => {
    const out = parseDistilledDigest(JSON.stringify({ persona: 'ক'.repeat(5000), scenarios: [] }))
    expect(out.persona.length).toBe(MAX_PERSONA_CHARS)
  })

  it('hard-caps scenario count, summary and topic length', () => {
    const out = parseDistilledDigest(
      JSON.stringify({
        persona,
        scenarios: Array.from({ length: 10 }, (_, i) => ({
          topic: `বিষয় ${i} ${'ক'.repeat(100)}`,
          summary: 'খ'.repeat(2000),
        })),
      }),
    )
    expect(out.scenarios).toHaveLength(MAX_SCENARIOS)
    for (const s of out.scenarios) {
      expect(s.topic.length).toBeLessThanOrEqual(MAX_TOPIC_CHARS)
      expect(s.summary.length).toBeLessThanOrEqual(MAX_SCENARIO_CHARS)
    }
  })

  it('drops scenarios with no topic or a too-thin summary', () => {
    const out = parseDistilledDigest(
      JSON.stringify({
        persona,
        scenarios: [{ topic: '', summary: 'যথেষ্ট লম্বা একটা সারাংশ এখানে আছে' }, { topic: 'অর্ডার', summary: 'ছোট' }, scenario],
      }),
    )
    expect(out.scenarios).toEqual([scenario])
  })

  it('drops a persona that is too thin to be a standing pattern', () => {
    expect(parseDistilledDigest(JSON.stringify({ persona: 'ভালো', scenarios: [] })).persona).toBe('')
  })

  it('deduplicates repeated topics', () => {
    const out = parseDistilledDigest(
      JSON.stringify({ persona, scenarios: [scenario, { ...scenario, summary: `${scenario.summary} আবার` }] }),
    )
    expect(out.scenarios).toHaveLength(1)
  })

  it('survives wrong-typed fields', () => {
    const out = parseDistilledDigest(JSON.stringify({ persona: 42, scenarios: 'nope' }))
    expect(out).toEqual({ persona: '', scenarios: [] })
    const out2 = parseDistilledDigest(JSON.stringify({ persona, scenarios: [null, 7, scenario] }))
    expect(out2.scenarios).toEqual([scenario])
  })
})
