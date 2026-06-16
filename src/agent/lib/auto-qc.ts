/**
 * Auto-QC hook — shadow mode.
 * When a product/listing photo is detected (via task proof or direct upload),
 * automatically runs qc_inspect_photo and notifies the owner if score < threshold.
 * Shadow mode: notify only, never block.
 */
import { geminiVisionJson } from '@/agent/lib/vision-analyze'
import { logToolEvent } from '@/agent/lib/tool-telemetry'

const QC_THRESHOLD = 70
const SHADOW_MODE = true

interface QcResult {
  lighting: string
  background_clean: boolean
  wrinkles: string
  brand_frame_ok: boolean
  crop_ok: boolean
  score: number
  issues: string[]
  verdict: string
}

const QC_PROMPT = `You are a fashion e-commerce QC inspector for ALMA Lifestyle (Bangladesh).
Inspect this product/listing photo and return JSON only:
{
  "lighting": "good|acceptable|poor",
  "background_clean": true|false,
  "wrinkles": "none|minor|major",
  "brand_frame_ok": true|false,
  "crop_ok": true|false,
  "score": 0-100,
  "issues": ["list of specific problems found"],
  "verdict": "pass|minor_fix|reshoot"
}
Score guide: 90-100=excellent, 70-89=good, 50-69=needs fix, <50=reshoot.
Be strict on: white/clean background, no wrinkles, proper lighting, full product visible, no blur.`

export interface AutoQcResult {
  ran: boolean
  score?: number
  verdict?: string
  issues?: string[]
  belowThreshold: boolean
}

/**
 * Run auto-QC on a product photo. Returns structured result.
 * In shadow mode, this only inspects and reports — never blocks publishing.
 */
export async function runAutoQc(
  imageBase64: string,
  mimeType: string,
): Promise<AutoQcResult> {
  const started = Date.now()
  try {
    const result = await geminiVisionJson<QcResult>({
      prompt: QC_PROMPT,
      imageBase64,
      mimeType,
      costKind: 'vision_auto_qc',
    })

    const score = typeof result.score === 'number' ? result.score : 0
    const belowThreshold = score < QC_THRESHOLD

    void logToolEvent({
      surface: 'scheduler',
      toolName: 'auto_qc_inspect',
      success: true,
      errorClass: belowThreshold ? 'qc_below_threshold' : undefined,
      latencyMs: Date.now() - started,
    })

    return {
      ran: true,
      score,
      verdict: result.verdict ?? 'unknown',
      issues: result.issues ?? [],
      belowThreshold,
    }
  } catch (err) {
    void logToolEvent({
      surface: 'scheduler',
      toolName: 'auto_qc_inspect',
      success: false,
      errorClass: 'qc_vision_error',
      latencyMs: Date.now() - started,
    })
    console.error('[auto-qc] vision failed:', err instanceof Error ? err.message : err)
    return { ran: false, belowThreshold: false }
  }
}

/**
 * Format a QC notification for the owner (Bangla).
 */
export function formatQcNotification(result: AutoQcResult, taskTitle?: string): string {
  if (!result.ran) return ''
  const prefix = taskTitle ? `📸 "${taskTitle}" ` : '📸 Product photo '
  const lines = [
    `${prefix}— QC Score: ${result.score}/100 (${result.verdict})`,
  ]
  if (result.issues && result.issues.length > 0) {
    lines.push('Issues:')
    for (const issue of result.issues.slice(0, 5)) {
      lines.push(`  • ${issue}`)
    }
  }
  if (result.belowThreshold) {
    lines.push(`⚠️ Score ${QC_THRESHOLD}-এর নিচে — ${SHADOW_MODE ? 'shadow mode (notify only)' : 'publish blocked'}`)
  }
  return lines.join('\n')
}

export { QC_THRESHOLD, SHADOW_MODE }
