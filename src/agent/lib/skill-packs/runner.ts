/**
 * P4 skill-pack completion gate — deterministic, fail-safe to NOT-done
 * (the completion-gate property from the plan-driver, applied to packs:
 * a flaky report makes the agent more cautious, never falsely "done").
 *
 * The head runs a pack by following its fixed steps, then calls the gate with
 * per-step evidence + the artifact body. The gate:
 *   • verifies every REQUIRED step has non-trivial evidence (skips need a reason),
 *   • verifies every checklist item is answered true,
 *   • uploads the artifact to agent storage + records an AgentArtifact row
 *     (the P0 "success WITH proof" half),
 *   • on ANY miss → success:false + a P0 checkpoint (failure-WITH-checkpoint half)
 *     so the run resumes from the exact missing step, never silently "done".
 */
import { prisma } from '@/lib/prisma'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'
import { writeCheckpoint } from '@/agent/lib/checkpoint'
import { getSkillPack, type SkillPack } from './packs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type StepEvidence = {
  stepId: string
  done: boolean
  /** what was actually done/found — tool outputs summarized, numbers included */
  evidence?: string
  /** required when an OPTIONAL step is skipped */
  skipReason?: string
}

export type PackRunReport = {
  packKey: string
  conversationId?: string | null
  goal: string
  steps: StepEvidence[]
  /** checklist answers, same order as pack.checklist */
  checklist: boolean[]
  /** the artifact document body (markdown, Bangla) */
  artifactMarkdown: string
}

export type PackGateResult =
  | { done: true; artifactUrl: string | null; artifactId: string | null; storagePath: string }
  | { done: false; missing: string[]; checkpointId: string | null }

const MIN_EVIDENCE_CHARS = 30
const MIN_ARTIFACT_CHARS = 200

/** Deterministic verdict: what (if anything) blocks completion. */
export function findGateMisses(pack: SkillPack, report: PackRunReport): string[] {
  const missing: string[] = []
  const byId = new Map(report.steps.map((s) => [s.stepId, s]))

  for (const step of pack.steps) {
    const ev = byId.get(step.id)
    if (step.required) {
      if (!ev || !ev.done) missing.push(`required step not done: ${step.id}`)
      else if (!ev.evidence || ev.evidence.trim().length < MIN_EVIDENCE_CHARS) {
        missing.push(`required step has no real evidence: ${step.id}`)
      }
    } else if (ev && !ev.done && !(ev.skipReason ?? '').trim()) {
      missing.push(`optional step skipped without a reason: ${step.id}`)
    }
  }

  if (report.checklist.length !== pack.checklist.length) {
    missing.push(`checklist incomplete: expected ${pack.checklist.length} answers, got ${report.checklist.length}`)
  } else {
    report.checklist.forEach((ok, i) => {
      if (!ok) missing.push(`checklist item not satisfied: "${pack.checklist[i]}"`)
    })
  }

  if ((report.artifactMarkdown ?? '').trim().length < MIN_ARTIFACT_CHARS) {
    missing.push(`artifact too thin (<${MIN_ARTIFACT_CHARS} chars) — the pack's proof document is mandatory`)
  }

  return missing
}

/**
 * Run the completion gate. Never throws — an internal error is a NOT-done
 * verdict with the error listed (fail-safe direction).
 */
export async function completeSkillPackRun(report: PackRunReport): Promise<PackGateResult> {
  const pack = getSkillPack(report.packKey)
  if (!pack) return { done: false, missing: [`unknown pack: ${report.packKey}`], checkpointId: null }

  const missing = findGateMisses(pack, report)
  if (missing.length > 0) {
    const doneSteps = report.steps
      .filter((s) => s.done && (s.evidence ?? '').trim().length >= MIN_EVIDENCE_CHARS)
      .map((s) => `${s.stepId}: ${(s.evidence ?? '').slice(0, 120)}`)
    const checkpointId = await writeCheckpoint({
      taskRef: `skillpack-${pack.key}-${report.conversationId ?? 'na'}`,
      taskType: 'skill_pack',
      goal: report.goal || pack.goal,
      summaryBn: `${pack.artifact.titleBn} শেষ করার আগে গেট আটকেছে — ${missing.length}টা ঘাটতি বাকি।`,
      doneSteps,
      currentStep: missing[0],
      artifacts: [],
      error: missing.join('; ').slice(0, 500),
      nextActions: missing.map((m) => `fix: ${m}`),
      resumeHint:
        `Skill pack "${pack.key}" incomplete. Misses: ${missing.join('; ')}. ` +
        `Re-run the missing steps, then call complete_skill_pack_run again with full evidence.`,
      conversationId: report.conversationId ?? null,
    })
    return { done: false, missing, checkpointId }
  }

  // Gate passed → publish the proof artifact (storage + AgentArtifact row).
  try {
    const stamp = new Date().toISOString().slice(0, 10)
    const storagePath = `skill-packs/${pack.key}/${stamp}-${Math.random().toString(36).slice(2, 8)}.md`
    await agentStorageUpload(storagePath, Buffer.from(report.artifactMarkdown, 'utf8'), 'text/markdown', {
      upsert: true,
    })
    const artifactUrl = await agentStorageSignedUrl(storagePath, 7 * 24 * 3600).catch(() => null)

    let artifactId: string | null = null
    if (report.conversationId) {
      try {
        const row = await db.agentArtifact.create({
          data: {
            conversationId: report.conversationId,
            type: pack.artifact.type,
            title: pack.artifact.titleBn,
            content: report.artifactMarkdown,
          },
          select: { id: true },
        })
        artifactId = row.id as string
      } catch { /* artifact row is nice-to-have; the storage object is the proof */ }
    }
    return { done: true, artifactUrl, artifactId, storagePath }
  } catch (err) {
    // Upload failed → NOT done (never claim success without the proof object).
    const msg = err instanceof Error ? err.message : String(err)
    const checkpointId = await writeCheckpoint({
      taskRef: `skillpack-${pack.key}-${report.conversationId ?? 'na'}`,
      taskType: 'skill_pack',
      goal: report.goal || pack.goal,
      summaryBn: `${pack.artifact.titleBn} তৈরি হয়েছিল কিন্তু আপলোড ব্যর্থ — প্রমাণ ছাড়া done বলা যাবে না।`,
      doneSteps: report.steps.filter((s) => s.done).map((s) => s.stepId),
      currentStep: 'artifact upload',
      artifacts: [],
      error: msg,
      nextActions: ['retry complete_skill_pack_run (same report)'],
      resumeHint: `Artifact upload failed (${msg}). The report content is complete — retry the gate call.`,
      conversationId: report.conversationId ?? null,
    })
    return { done: false, missing: [`artifact upload failed: ${msg}`], checkpointId }
  }
}
