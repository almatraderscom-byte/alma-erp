/**
 * P4 skill-pack tools (docs/agent-computer-use-roadmap.md Phase P4).
 *
 *   • start_skill_pack        — fetch a pack's FIXED protocol (steps, checklist,
 *                               guardrails). The head follows it verbatim.
 *   • complete_skill_pack_run — the deterministic completion gate: evidence per
 *                               step + checklist + the artifact document. Done
 *                               ONLY with proof; anything missing → P0 checkpoint.
 */
import type { AgentTool } from './registry'
import { SKILL_PACKS, getSkillPack } from '@/agent/lib/skill-packs/packs'
import { completeSkillPackRun, type PackRunReport, type StepEvidence } from '@/agent/lib/skill-packs/runner'

const start_skill_pack: AgentTool = {
  name: 'start_skill_pack',
  description:
    'Start one of the DETERMINISTIC skill packs — fixed playbooks for the big recurring jobs: ' +
    '"research" (multi-source, cross-checked, cited brief), "seo" (own-site audit + Search Console/GA4 ' +
    'readout + prioritized fixes), "marketing" (performance + competitor scan + weekly brief, ALL spend ' +
    'owner-gated), "website" (improvements shipped ONLY as owner-gated proposals/PRs), "client_seo" ' +
    '(end-to-end audit of ANY website — own or a customer\'s — then a prioritized fix plan where the agent ' +
    'prepares the safe fixes and hands every critical / login / irreversible step to the owner).\n' +
    'It returns the pack PROTOCOL: ordered steps (each naming the exact tools to use), a checklist, and ' +
    'guardrails. FOLLOW THE STEPS IN ORDER — no freestyle, no skipping required steps. Collect concrete ' +
    'evidence per step (numbers, URLs, tool outputs) as you go; you will need it for the completion ' +
    'gate. When every step is done, write the pack artifact (Bangla markdown) and call ' +
    'complete_skill_pack_run — a pack is NOT finished until that gate passes.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pack: {
        type: 'string',
        enum: ['research', 'seo', 'marketing', 'website', 'client_seo'],
        description: 'Which skill pack to run.',
      },
      goal: {
        type: 'string',
        description: "The owner's concrete goal for this run, one line (e.g. the research question).",
      },
    },
    required: ['pack'],
  },
  handler: async (input) => {
    const pack = getSkillPack(String(input.pack ?? ''))
    if (!pack) {
      return {
        success: false,
        error: `unknown pack — available: ${Object.keys(SKILL_PACKS).join(', ')}`,
      }
    }
    return {
      success: true,
      data: {
        pack: pack.key,
        title: pack.title,
        goal: String(input.goal ?? '').trim() || pack.goal,
        steps: pack.steps,
        checklist: pack.checklist,
        guardrails: pack.guardrails,
        artifact: pack.artifact,
        note:
          'Follow the steps IN ORDER. Required steps cannot be skipped; optional steps need a skip ' +
          'reason. Keep evidence per step. Finish by calling complete_skill_pack_run with the full ' +
          'report — done-without-proof is impossible by design.',
      },
    }
  },
}

const complete_skill_pack_run: AgentTool = {
  name: 'complete_skill_pack_run',
  description:
    'The COMPLETION GATE for a skill-pack run (call after finishing the steps from start_skill_pack). ' +
    'Pass per-step evidence, the checklist answers (same order as the pack checklist), and the full ' +
    'artifact document (Bangla markdown). The gate is deterministic and fail-safe to NOT-done: any ' +
    'required step without real evidence, any unchecked checklist item, or a thin artifact → it refuses, ' +
    'writes a P0 checkpoint with exactly what is missing, and you fix + call again. On pass it uploads ' +
    'the artifact to storage (the proof) and returns its link — only THEN tell the owner the pack is done.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pack: { type: 'string', enum: ['research', 'seo', 'marketing', 'website', 'client_seo'], description: 'Which skill pack this run belongs to (same as start_skill_pack)' },
      goal: { type: 'string', description: 'The run goal (same as start_skill_pack).' },
      steps: {
        type: 'array',
        description: 'Evidence per pack step (every required step must appear with done=true).',
        items: {
          type: 'object',
          properties: {
            stepId: { type: 'string' },
            done: { type: 'boolean' },
            evidence: {
              type: 'string',
              description: 'What was actually done/found — concrete: numbers, URLs, tool outputs.',
            },
            skipReason: { type: 'string', description: 'Required when skipping an OPTIONAL step.' },
          },
          required: ['stepId', 'done'],
        },
      },
      checklist: {
        type: 'array',
        items: { type: 'boolean' },
        description: 'One true/false per checklist item, in the pack order. All must be true to pass.',
      },
      artifactMarkdown: {
        type: 'string',
        description: 'The full pack artifact (Bangla markdown) — the proof document.',
      },
    },
    required: ['pack', 'steps', 'checklist', 'artifactMarkdown'],
  },
  handler: async (input) => {
    try {
      const report: PackRunReport = {
        packKey: String(input.pack ?? ''),
        conversationId: typeof input.conversationId === 'string' ? input.conversationId : null,
        goal: String(input.goal ?? ''),
        steps: Array.isArray(input.steps) ? (input.steps as StepEvidence[]) : [],
        checklist: Array.isArray(input.checklist) ? (input.checklist as boolean[]).map(Boolean) : [],
        artifactMarkdown: String(input.artifactMarkdown ?? ''),
      }
      const result = await completeSkillPackRun(report)
      if (result.done) {
        return {
          success: true,
          data: {
            done: true,
            artifactUrl: result.artifactUrl,
            storagePath: result.storagePath,
            message: 'গেট পাস — artifact আপলোড হয়েছে। এবার owner-কে লিংকসহ জানান।',
          },
        }
      }
      return {
        success: false,
        error:
          `pack NOT done — ${result.missing.length} miss(es): ${result.missing.join('; ')}. ` +
          'Checkpoint saved. Fix the misses and call complete_skill_pack_run again.',
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const SKILL_PACK_TOOLS: AgentTool[] = [start_skill_pack, complete_skill_pack_run]
