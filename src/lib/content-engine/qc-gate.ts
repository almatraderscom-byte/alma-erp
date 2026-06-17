/**
 * Content engine QC gate — runs auto-QC before Gate 2 publish.
 * Blocks auto-post when score below threshold (shadow notifies only).
 */
import { agentStorageDownload } from '@/agent/lib/storage'
import { runAutoQc, QC_THRESHOLD, formatQcNotification } from '@/agent/lib/auto-qc'
import { notifyOwner } from '@/agent/lib/notify-owner'

export type ContentQcGateResult = {
  passed: boolean
  score?: number
  verdict?: string
  issues?: string[]
  blocked: boolean
}

export async function runContentQcGate(imagePath: string | null): Promise<ContentQcGateResult> {
  if (!imagePath) {
    return { passed: true, blocked: false }
  }

  try {
    const buf = await agentStorageDownload(imagePath)
    const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const qc = await runAutoQc(buf.toString('base64'), mime)

    if (!qc.ran) {
      return { passed: true, blocked: false }
    }

    const passed = !qc.belowThreshold
    const blocked = qc.belowThreshold

    if (blocked) {
      const note = formatQcNotification(qc, imagePath)
      void notifyOwner({
        tier: 1,
        title: '📸 Content QC Blocked Publish',
        message: note || `QC score ${qc.score}/${QC_THRESHOLD} — publish blocked.`,
        category: 'urgent',
      })
    }

    return {
      passed,
      score: qc.score,
      verdict: qc.verdict,
      issues: qc.issues,
      blocked,
    }
  } catch (err) {
    console.warn('[content-qc-gate] failed:', err instanceof Error ? err.message : err)
    return { passed: true, blocked: false }
  }
}
