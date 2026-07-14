import type { AgentTool } from './registry'
import { getQcLevel, setQcLevel, type QCLevel } from '@/lib/tryon/qc-gate'

const set_qc_level: AgentTool = {
  name: 'set_qc_level',
  description:
    'Set designer QC gate level for generated creatives. ' +
    'off = bypass (fast); normal = pass ≥4, regen up to 2 (default); strict = higher bar (min axis 3), same regen cap.',
  input_schema: {
    type: 'object' as const,
    properties: {
      level: { type: 'string', enum: ['off', 'normal', 'strict'], description: 'QC gate level for generated creatives' },
    },
    required: ['level'],
  },
  handler: async (input) => {
    const raw = String(input.level ?? '').toLowerCase()
    if (raw !== 'off' && raw !== 'normal' && raw !== 'strict') {
      return { success: false, error: 'level must be off, normal, or strict' }
    }
    await setQcLevel(raw as QCLevel)
    const current = await getQcLevel()
    return {
      success: true,
      data: {
        level: current,
        message:
          current === 'off'
            ? 'QC bypass — creatives show immediately (no auto-regen).'
            : current === 'strict'
              ? 'QC strict — higher pass bar, up to 2 auto-regens before best-of-N.'
              : 'QC normal — standard e-commerce rubric, up to 2 auto-regens.',
      },
    }
  },
}

export const QC_TOOLS: AgentTool[] = [set_qc_level]

export const QC_ROLE_PROMPT = `
## DESIGNER QC (File 16)
Every generated creative is vision-scored before owner sees it. Failed QC auto-regenerates (max 2), then best-of-N flagged.
set_qc_level: off | normal (default) | strict.
`
