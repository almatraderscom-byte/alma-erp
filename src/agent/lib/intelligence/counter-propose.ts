import { prisma } from '@/lib/prisma'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface ConflictSignal {
  source: 'playbook' | 'outcome' | 'data' | 'memory'
  detail: string
  confidence: number
  alternative: string
}

/**
 * Detects conflicts between an owner instruction and the agent's
 * accumulated knowledge (playbook rules, outcome learnings, data).
 * Returns signals only when confidence >= 60%.
 */
export async function detectInstructionConflicts(
  instruction: string,
  businessId: AgentBusinessId,
): Promise<ConflictSignal[]> {
  if (!instruction || instruction.length < 10) return []

  const conflicts: ConflictSignal[] = []
  const instrLower = instruction.toLowerCase()

  // 1. Check against active playbook rules
  try {
    const rules = await db.agentPlaybook.findMany({
      where: { businessId, status: 'active' },
      select: { heuristic: true, domain: true, confidence: true },
    }) as Array<{ heuristic: string; domain: string; confidence: number }>

    for (const rule of rules) {
      if (instructionContradictsRule(instrLower, rule.heuristic.toLowerCase())) {
        conflicts.push({
          source: 'playbook',
          detail: `Active playbook rule: "${rule.heuristic}"`,
          confidence: Math.min(rule.confidence * 20, 95),
          alternative: `Playbook rule (${rule.domain}) suggests a different approach`,
        })
      }
    }
  } catch { /* non-fatal */ }

  // 2. Check outcome learnings for negative patterns
  try {
    const memories = await db.agentMemory.findMany({
      where: { scope: 'business' },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { content: true, metadata: true },
    }) as Array<{ content: string; metadata: Record<string, unknown> | null }>

    for (const mem of memories) {
      const meta = mem.metadata
      if (!meta || meta.type !== 'outcome_learning') continue
      if (meta.result === 'worse' || meta.result === 'no_effect') {
        if (contentOverlaps(instrLower, mem.content.toLowerCase())) {
          conflicts.push({
            source: 'outcome',
            detail: mem.content,
            confidence: 75,
            alternative: 'Previous similar attempt was unsuccessful — consider alternative approach',
          })
        }
      }
    }

    // 3. Check owner decisions that might contradict
    for (const mem of memories) {
      const meta = mem.metadata
      if (!meta || meta.type !== 'owner_decision') continue
      if (instructionContradictsDecision(instrLower, mem.content.toLowerCase())) {
        conflicts.push({
          source: 'memory',
          detail: `Owner previously decided: "${mem.content}"`,
          confidence: 80,
          alternative: 'This may conflict with a previous decision',
        })
      }
    }
  } catch { /* non-fatal */ }

  return conflicts.filter(c => c.confidence >= 60).slice(0, 3)
}

function instructionContradictsRule(instruction: string, rule: string): boolean {
  const negativePatterns = ['avoid', 'না', "don't", 'stop', 'কম', 'বাদ', 'never', 'নিষিদ্ধ']
  for (const neg of negativePatterns) {
    if (!rule.includes(neg)) continue
    const ruleWords = rule.split(/\s+/)
    const negIdx = ruleWords.findIndex(w => w.includes(neg))
    if (negIdx < 0 || negIdx + 1 >= ruleWords.length) continue
    const subject = ruleWords.slice(negIdx + 1, negIdx + 4).join(' ')
    if (subject.length > 3 && instruction.includes(subject)) return true
  }
  return false
}

function instructionContradictsDecision(instruction: string, decision: string): boolean {
  const instrWords = new Set(instruction.split(/\s+/).filter(w => w.length > 4))
  const decWords = decision.split(/\s+/).filter(w => w.length > 4)
  let overlap = 0
  for (const w of decWords) {
    if (instrWords.has(w)) overlap++
  }
  if (overlap < 2) return false

  const opposites = [
    ['বাড়াও', 'কমাও'], ['start', 'stop'], ['enable', 'disable'],
    ['চালু', 'বন্ধ'], ['হ্যাঁ', 'না'], ['approve', 'reject'],
  ]
  for (const [a, b] of opposites) {
    if ((instruction.includes(a) && decision.includes(b)) ||
        (instruction.includes(b) && decision.includes(a))) {
      return true
    }
  }
  return false
}

function contentOverlaps(instruction: string, content: string): boolean {
  const instrWords = new Set(instruction.split(/\s+/).filter(w => w.length > 4))
  const memWords = content.split(/\s+/).filter(w => w.length > 4)
  let overlap = 0
  for (const w of memWords) {
    if (instrWords.has(w)) overlap++
  }
  return overlap >= 3
}
