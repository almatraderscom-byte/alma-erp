import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL } from '@/agent/config'

export type PersonalCheckinKind = 'midday' | 'evening'

type OpenWorry = { id: string; content: string; createdAt: Date }

async function loadOpenPersonalWorries(): Promise<OpenWorry[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rows = await db.agentMemory.findMany({
    where: { scope: 'personal' },
    orderBy: { updatedAt: 'desc' },
    take: 40,
    select: { id: true, content: true, metadata: true, createdAt: true },
  })
  return rows
    .filter((r: { metadata: unknown }) => {
      const meta = r.metadata as { type?: string; open?: boolean } | null
      return meta?.type === 'personal_worry' && meta?.open !== false
    })
    .slice(0, 3)
    .map((r: { id: string; content: string; createdAt: Date }) => ({
      id: r.id,
      content: r.content,
      createdAt: r.createdAt,
    }))
}

async function loadFamilyContactsSummary(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rows = await db.familyContact.findMany({
    select: { name: true, relation: true },
    orderBy: { createdAt: 'asc' },
    take: 8,
  })
  if (!rows.length) return 'কোনো পরিবারের contact সেভ নেই।'
  return rows.map((c: { relation: string; name: string }) => `${c.relation} (${c.name})`).join(', ')
}

const FALLBACK: Record<PersonalCheckinKind, string> = {
  midday:
    'স্যার, দিনটা কেমন যাচ্ছে? সব ঠিক আছে তো? কিছু দরকার হলে বা মন খারাপ থাকলে বলবেন — আমি আছি। 🤲',
  evening:
    'আসসালামু আলাইকুম স্যার। দিনটা কেমন গেল? পরিবারের সবার সাথে কথা হয়েছে আজ? কোনো কিছু মন খারাপ করছে কি না — বলতে পারেন, আমি আছি।',
}

export async function composePersonalCheckin(kind: PersonalCheckinKind = 'evening'): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return FALLBACK[kind]

  const [worries, familySummary] = await Promise.all([
    loadOpenPersonalWorries(),
    kind === 'evening' ? loadFamilyContactsSummary() : Promise.resolve(''),
  ])

  const worryLines = worries.length
    ? worries.map((w) => `- ${w.content}`).join('\n')
    : '(কোনো খোলা চিন্তা সেভ নেই)'

  const userPrompt = kind === 'midday'
    ? (
      `Compose ONE brief midday personal check-in in Bangla for the owner (address as স্যার).\n` +
      `Kind: midday (short খোঁজখবর during work hours)\n` +
      `Open worries from memory:\n${worryLines}\n` +
      `Rules: MAX 1-2 short lines only; warm, light, Islamic-gentle; if an open worry exists, reference it lightly ("সকালে যে বিষয়টা বলেছিলেন, ঠিক আছে তো?"); otherwise simple caring check. ` +
      `Do NOT write a long emotional session. Vary wording from day to day. No fake Quran/hadith.`
    )
    : (
      `Compose ONE short evening personal check-in message in Bangla for the owner (address as স্যার).\n` +
      `Kind: evening (deeper reflection)\n` +
      `Open worries from memory:\n${worryLines}\n` +
      `Saved family contacts: ${familySummary}\n` +
      `Rules: max 4 sentences; warm Islamic tone; if an open worry exists, gently follow up; ask if he spoke with family today; offer presence. ` +
      `Vary wording from day to day. No fake Quran/hadith citations.`
    )

  try {
    const client = new Anthropic({ apiKey })
    const res = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: kind === 'midday' ? 150 : 200,
      system: 'Brief Bangla personal check-in only. Warm, Islamic-gentle. No fake Quran/hadith. Max 4 sentences evening / 2 lines midday.',
      messages: [{ role: 'user', content: userPrompt }],
    })
    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    return text || FALLBACK[kind]
  } catch (err) {
    console.error('[personal-checkin] LLM failed:', err)
    return FALLBACK[kind]
  }
}
