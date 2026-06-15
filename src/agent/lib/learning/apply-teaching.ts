/**
 * Owner explicit teaching → high-importance memory + active playbook rule.
 */
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import { prisma } from '@/lib/prisma'
import type { TeachingDomain, TeachingIntent } from '@/agent/lib/learning/teaching-intent'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type AppliedTeaching = {
  memoryId: string
  playbookId: string
  ruleText: string
  domain: TeachingDomain
  confirmationBn: string
}

function playbookDomainFor(d: TeachingDomain): string {
  if (d === 'personal') return 'ops'
  return d
}

export async function applyOwnerTeaching(args: {
  intent: TeachingIntent
  businessId: AgentBusinessId
}): Promise<AppliedTeaching> {
  const { intent, businessId } = args
  const domain = playbookDomainFor(intent.domain)
  const key = `owner_rule_${Date.now()}`

  const mem = await createOrUpdateAgentMemory({
    scope: 'preference',
    key,
    content: intent.ruleText,
    pinned: true,
    importance: 5,
    metadata: { businessId, source: 'owner_teaching', domain },
  })

  const existing = await db.agentPlaybook.findFirst({
    where: {
      businessId,
      domain,
      status: 'active',
      heuristic: intent.ruleText.slice(0, 200),
    },
    select: { id: true },
  })

  let playbookId: string
  if (existing) {
    playbookId = existing.id
    await db.agentPlaybook.update({
      where: { id: existing.id },
      data: { reviewedAt: new Date(), confidence: 5 },
    })
  } else {
    const row = await db.agentPlaybook.create({
      data: {
        businessId,
        domain,
        heuristic: intent.ruleText.slice(0, 500),
        evidence: JSON.stringify({
          source: 'owner_teaching',
          rawText: intent.rawText.slice(0, 300),
          appliedAt: new Date().toISOString(),
        }),
        confidence: 5,
        status: 'active',
        reviewedAt: new Date(),
      },
    })
    playbookId = row.id
  }

  const shortRule = intent.ruleText.length > 120
    ? `${intent.ruleText.slice(0, 117)}…`
    : intent.ruleText

  const confirmationBn =
    `বুঝেছি স্যার — এটা এখন থেকে নিয়ম হিসেবে রাখলাম: "${shortRule}"। ` +
    `চাইলে list_learned দিয়ে দেখতে পারেন।`

  return {
    memoryId: mem.id,
    playbookId,
    ruleText: intent.ruleText,
    domain: intent.domain,
    confirmationBn,
  }
}

export function buildTeachingTurnPromptBlock(applied: AppliedTeaching): string {
  return (
    `\n## এই টার্নে owner শিখিয়েছেন — অবশ্য confirm করুন\n` +
    `Active rule + memory saved.\n` +
    `Rule: "${applied.ruleText.slice(0, 200)}"\n` +
    `আপনার প্রথম উত্তরে অবশ্যই এই confirmation naturally যোগ করুন:\n` +
    `"${applied.confirmationBn}"\n` +
    `অতিরিক্ত বক্তব্য না — শুধু একবার clear confirm, তারপর স্বাভাবিক উত্তর।`
  )
}
