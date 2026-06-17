/**
 * CS auto-reply confidence scoring — gates live auto-send (shadow bypasses send anyway).
 * Threshold configurable via CS_AUTO_CONFIDENCE_THRESHOLD (default 0.72).
 */
import type { CsReplyPart } from '@/agent/lib/cs/core'

export type CsConfidenceResult = {
  score: number
  reasons: string[]
  escalate: boolean
}

const DEFAULT_THRESHOLD = 0.72

export function csConfidenceThreshold(): number {
  const n = Number(process.env.CS_AUTO_CONFIDENCE_THRESHOLD)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_THRESHOLD
}

export function scoreCsReplyConfidence(input: {
  userText: string
  parts: CsReplyPart[]
  handedOff: boolean
  hadToolUse?: boolean
}): CsConfidenceResult {
  const reasons: string[] = []
  let score = 0.55

  const replyText = input.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .trim()

  if (input.handedOff) {
    return { score: 0, reasons: ['handoff_to_human'], escalate: true }
  }

  if (!replyText) {
    return { score: 0.2, reasons: ['empty_reply'], escalate: true }
  }

  if (replyText.length >= 20) { score += 0.12; reasons.push('adequate_length') }
  if (replyText.length >= 80) { score += 0.05; reasons.push('detailed') }

  const uncertain = [
    /not sure|don't know|unsure|maybe|perhaps/i,
    /জানি\s*না|নিশ্চিত\s*নই|হয়তো|মনে\s*হয়\s*না/i,
  ]
  if (uncertain.some((r) => r.test(replyText))) {
    score -= 0.25
    reasons.push('uncertain_language')
  }

  const hedging = [/contact support|call us|inbox/i, /ইনবক্স|কল\s*কর|সাপোর্ট/i]
  if (hedging.some((r) => r.test(replyText))) {
    score -= 0.1
    reasons.push('hedging')
  }

  if (/৳|tk|taka|price|দাম|stock|স্টক|size|সাইজ/i.test(replyText)) {
    score += 0.1
    reasons.push('concrete_info')
  }

  if (input.hadToolUse) {
    score += 0.15
    reasons.push('tool_verified')
  }

  if (input.parts.some((p) => p.type === 'image')) {
    score += 0.05
    reasons.push('has_image')
  }

  const userLen = input.userText.trim().length
  if (userLen > 10 && userLen < 400) {
    score += 0.05
    reasons.push('normal_query')
  }

  score = Math.max(0, Math.min(1, score))
  const threshold = csConfidenceThreshold()
  const escalate = score < threshold

  if (escalate) reasons.push(`below_threshold_${threshold}`)

  return { score, reasons, escalate }
}
