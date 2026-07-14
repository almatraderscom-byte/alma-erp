#!/usr/bin/env node
/**
 * Export real owner conversations into replay-case skeletons
 * (Roadmap Phase 0 — AGENT-EVAL-001).
 *
 * Reads recent AgentConversation/AgentMessage rows, ANONYMIZES the text (phones,
 * emails, long digit runs), and writes one skeleton JSON per selected turn to
 * src/agent/replay/fixtures-drafts/ (git-ignored area of truth: the human/agent
 * then fills `expected` + trims the transcript and moves the finished case into
 * src/agent/replay/fixtures/). Skeletons are deliberately NOT valid fixtures
 * until reviewed — the format test only runs on fixtures/.
 *
 * Usage (needs DATABASE_URL, read-only queries):
 *   node scripts/export-replay-cases.mjs --days 30 --limit 100
 *   node scripts/export-replay-cases.mjs --conversation <id>
 */
import { PrismaClient } from '@prisma/client'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const DAYS = Number(flag('days', '30'))
const LIMIT = Number(flag('limit', '100'))
const ONLY_CONVERSATION = flag('conversation', null)

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent', 'replay', 'fixtures-drafts')

/** Strip PII the fixtures must never carry into git. */
function anonymize(text) {
  return String(text ?? '')
    .replace(/\+?88\s?0?1[3-9]\d{2}[-\s]?\d{6}/g, '[phone]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]')
    .replace(/\b\d{9,}\b/g, '[number]')
}

async function main() {
  const prisma = new PrismaClient()
  const since = new Date(Date.now() - DAYS * 86400 * 1000)

  const conversations = await prisma.agentConversation.findMany({
    where: ONLY_CONVERSATION
      ? { id: ONLY_CONVERSATION }
      : { updatedAt: { gte: since } },
    orderBy: { updatedAt: 'desc' },
    take: ONLY_CONVERSATION ? 1 : LIMIT,
    select: { id: true, updatedAt: true },
  })

  mkdirSync(OUT_DIR, { recursive: true })
  let n = 0
  for (const conv of conversations) {
    const messages = await prisma.agentMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
      take: 40,
      select: { role: true, content: true, createdAt: true },
    })
    if (messages.length < 2) continue
    const last = messages[messages.length - 1]
    const lastOwnerIdx = [...messages].reverse().findIndex((m) => m.role === 'user')
    if (lastOwnerIdx === -1) continue
    const latest = messages[messages.length - 1 - lastOwnerIdx]

    n += 1
    const skeleton = {
      id: `rc-DRAFT-${String(n).padStart(4, '0')}`,
      source: { conversationId: `anon-${conv.id.slice(0, 8)}`, turnAt: latest.createdAt.toISOString() },
      description: 'TODO: what went wrong / what must happen (plain language, no PII).',
      transcript: messages
        .filter((m) => m !== latest)
        .map((m) => ({
          role: m.role === 'user' ? 'owner' : m.role === 'assistant' ? 'agent' : 'tool',
          text: anonymize(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 500),
        })),
      latestMessage: anonymize(typeof latest.content === 'string' ? latest.content : JSON.stringify(latest.content)).slice(0, 500),
      expected: {
        intent: 'TODO',
        outcome: 'TODO: describe the correct final outcome.',
      },
      tags: ['draft'],
    }
    writeFileSync(join(OUT_DIR, `${skeleton.id}.json`), JSON.stringify(skeleton, null, 2) + '\n')
  }
  console.log(`Wrote ${n} draft skeleton(s) to ${OUT_DIR}`)
  console.log('Review each draft: fill expected.*, trim/anonymize transcript, rename to rc-<nnnn>-<title>.json, move into src/agent/replay/fixtures/.')
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
