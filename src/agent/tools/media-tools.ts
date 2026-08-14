/**
 * Media mode (CapCut-class video engine) — M0 planner tool.
 *
 * plan_media_video: head turns an owner idea into a MediaPlan, the server
 * normalizes it, recomputes the exact cost, stores an AgentMediaProject and
 * stages a `media_plan` approval card. Approval is the ONLY money gate; the
 * render graph (M1) starts from the approved plan.
 */
import { prisma } from '@/lib/prisma'
import { normalizeMediaPlan, type MediaPlan } from '@/agent/lib/media/plan-schema'
import { estimateMediaPlanCost, formatEstimateBn, mediaModelLabel } from '@/agent/lib/media/cost'
import type { AgentTool } from './registry'

// prisma delegate typed loosely until `prisma generate` runs everywhere (same pattern as video-tools)
const db = prisma as any

function planSummaryBn(plan: MediaPlan, estimateBlock: string): string {
  const sceneLines = plan.scenes
    .map((s) => `S${s.idx} (${s.durationSec}s): ${s.brief}${s.usesOwnerPhoto ? ' — Boss-এর ছবি' : ''}`)
    .join('\n')
  const audioLabel =
    plan.audio.mode === 'none' ? 'নীরব'
      : plan.audio.mode === 'music' ? 'শুধু মিউজিক'
        : plan.audio.mode === 'vo+music' ? 'ভয়েস + মিউজিক'
          : 'ভয়েসওভার'
  return (
    `🎬 ${plan.title}\n` +
    `মোট ${Math.round(plan.durationSec)}s | ${plan.aspect} | ${plan.language === 'bn' ? 'বাংলা' : plan.language}\n` +
    `দৃশ্য ${plan.scenes.length}টি | ছবি: ${mediaModelLabel(plan.models.image)} | ক্লিপ: ${mediaModelLabel(plan.models.video)} | অডিও: ${audioLabel}\n\n` +
    `${sceneLines}\n\n` +
    `খরচ (exact):\n${estimateBlock}\n\n` +
    `Approve করলেই জেনারেশন শুরু: আগে প্রতি দৃশ্যের অডিও, তারপর ছবি, তারপর ক্লিপ — প্রতিটা রেডি হলে এই চ্যাটে আসবে, শেষে সব জোড়া দিয়ে ফাইনাল ভিডিও। Approve-ই একমাত্র খরচের গেট।`
  )
}

const plan_media_video: AgentTool = {
  name: 'plan_media_video',
  description:
    'Media mode: turn ANY owner idea into a full AI video plan (scenes, per-scene image prompt + VO script + clip brief, ' +
    'model choices, exact cost) and stage it as an approval card. The server recomputes the cost — never invent estimate numbers. ' +
    'Call when the owner wants a video made from an idea (CapCut-style). Revisions (model swap, language, drop VO, use owner photos) ' +
    'go through the SAME tool with the projectId — it re-quotes and updates the card in place. Nothing generates before approval.',
  input_schema: {
    type: 'object' as const,
    properties: {
      plan: {
        type: 'object',
        description:
          'MediaPlan JSON: {title, aspect(9:16|16:9), language(bn|en|...), ' +
          'audio:{mode(vo|music|vo+music|none), voice(owner_clone|google|elevenlabs:<id>), musicBrief}, ' +
          'models:{image(gemini-3-pro-image|gemini-3.1-flash-image|seedream-5.0-pro), video(seedance-1.0-pro|seedance-1.0-lite|veo-3.1-fast|veo-3.1)}, ' +
          'personalization:{useOwnerPhotos, photoPaths[]}, captions, ' +
          'scenes:[{durationSec(3-10), brief, voScript, imagePrompt, clipBrief, usesOwnerPhoto}]}. ' +
          'Scene briefs/VO in the plan language; imagePrompt/clipBrief in rich English.',
      },
      projectId: { type: 'string', description: 'Existing media project id — pass ONLY when revising a plan already shown.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['plan'],
  },
  handler: async (input) => {
    try {
      const plan = normalizeMediaPlan(input.plan)
      const estimate = estimateMediaPlanCost(plan)
      plan.estimate = estimate
      const estimateBlock = formatEstimateBn(estimate)
      const summary = planSummaryBn(plan, estimateBlock)
      const conversationId = input.conversationId ? String(input.conversationId) : null

      const existingId = input.projectId ? String(input.projectId) : null
      const existing = existingId
        ? await db.agentMediaProject.findUnique({ where: { id: existingId } })
        : null
      if (existingId && !existing) {
        return { success: false, error: `media project ${existingId} not found` }
      }
      if (existing && !['draft', 'planned'].includes(existing.status)) {
        return {
          success: false,
          error: `project status ${existing.status} — approved/rendering প্ল্যান এই টুল দিয়ে বদলানো যায় না`,
        }
      }

      // Project + scenes + card move together in ONE transaction. The revision
      // CAS pins the exact (planRevision, pendingActionId) read above, so two
      // overlapping revisions can't interleave a card quoting one plan against
      // a project storing the other — the loser aborts and the head retries.
      const REVISION_LOST = 'MEDIA_PLAN_REVISION_CONFLICT'
      let project: { id: string; planRevision: number }
      let actionId: string
      try {
        const result = await db.$transaction(async (tx: typeof db) => {
          let proj
          if (existing) {
            const revised = await tx.agentMediaProject.updateMany({
              where: {
                id: existing.id,
                status: { in: ['draft', 'planned'] },
                planRevision: existing.planRevision,
                pendingActionId: existing.pendingActionId,
              },
              data: {
                title: plan.title,
                planJson: plan,
                planRevision: { increment: 1 },
                aspect: plan.aspect,
                language: plan.language,
                totalEstimateUsd: estimate.totalUsd,
                status: 'planned',
              },
            })
            if (revised.count === 0) throw new Error(REVISION_LOST)
            proj = await tx.agentMediaProject.findUnique({ where: { id: existing.id } })
            await tx.agentMediaScene.deleteMany({ where: { projectId: existing.id } })
            if (existing.pendingActionId) {
              // 'expired' is replaceable too: the generic 30-min TTL may have
              // settled the card while the project stayed planned — a revision
              // is exactly how the owner re-quotes it. Owner DECISIONS
              // (approved/rejected/superseded) still abort the revision.
              const superseded = await tx.agentPendingAction.updateMany({
                where: { id: existing.pendingActionId, status: { in: ['pending', 'expired'] } },
                data: { status: 'superseded', resolvedAt: new Date() },
              })
              if (superseded.count === 0) throw new Error(REVISION_LOST)
            }
          } else {
            proj = await tx.agentMediaProject.create({
              data: {
                conversationId,
                title: plan.title,
                planJson: plan,
                aspect: plan.aspect,
                language: plan.language,
                totalEstimateUsd: estimate.totalUsd,
                status: 'planned',
              },
            })
          }

          await tx.agentMediaScene.createMany({
            data: plan.scenes.map((s) => ({
              projectId: proj.id,
              idx: s.idx,
              brief: s.brief,
              voScript: s.voScript,
              imagePrompt: s.imagePrompt,
              clipBrief: s.clipBrief,
              durationSec: s.durationSec,
            })),
          })

          const card = await tx.agentPendingAction.create({
            data: {
              conversationId,
              type: 'media_plan',
              payload: {
                projectId: proj.id,
                planRevision: proj.planRevision,
                conversationId,
              },
              summary,
              costEstimate: estimate.totalBdt,
              status: 'pending',
            },
          })
          await tx.agentMediaProject.update({
            where: { id: proj.id },
            data: { pendingActionId: card.id },
          })
          return { proj, cardId: card.id as string }
        })
        project = result.proj
        actionId = result.cardId
      } catch (err) {
        if (err instanceof Error && err.message === REVISION_LOST) {
          return {
            success: false,
            error:
              'প্ল্যানটা এর মধ্যে অন্য জায়গা থেকে বদলে/approve হয়ে গেছে — get_media_project দিয়ে সর্বশেষ অবস্থা পড়ে আবার চেষ্টা করুন।',
          }
        }
        throw err
      }

      return {
        success: true,
        data: {
          pendingActionId: actionId,
          // Live-card emitters (core.ts / run-owner-turn.ts) read the event type
          // from d.actionType — without it the fresh card lands typeless and the
          // client revise path only works after a reload.
          actionType: 'media_plan',
          projectId: project.id,
          planRevision: project.planRevision,
          totalUsd: estimate.totalUsd,
          totalBdt: estimate.totalBdt,
          sceneCount: plan.scenes.length,
          message: existing
            ? 'প্ল্যান রিভাইজ হয়েছে — নতুন খরচসহ নতুন কার্ড এসেছে, আগেরটা বাতিল।'
            : 'ভিডিও প্ল্যান কার্ড তৈরি — approve করলে প্ল্যান+খরচ লক হবে (রেন্ডার ইঞ্জিন M1-এ)।',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const get_media_project: AgentTool = {
  name: 'get_media_project',
  description:
    'Media mode: read a media video project (plan, scenes, generated assets with versions/status). ' +
    'Use to answer owner questions about a project or before revising its plan.',
  input_schema: {
    type: 'object' as const,
    properties: {
      projectId: { type: 'string', description: 'Media project id. Omit to get the latest project in this conversation.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
  },
  handler: async (input) => {
    try {
      const projectId = input.projectId ? String(input.projectId) : null
      const conversationId = input.conversationId ? String(input.conversationId) : null
      const project = projectId
        ? await db.agentMediaProject.findUnique({ where: { id: projectId } })
        : await db.agentMediaProject.findFirst({
            where: conversationId ? { conversationId } : {},
            orderBy: { createdAt: 'desc' },
          })
      if (!project) return { success: false, error: 'কোনো media project পাওয়া যায়নি' }
      const [scenes, assets] = await Promise.all([
        db.agentMediaScene.findMany({ where: { projectId: project.id }, orderBy: { idx: 'asc' } }),
        db.agentMediaAsset.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } }),
      ])
      return { success: true, data: { project, scenes, assets } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const MEDIA_TOOLS: AgentTool[] = [plan_media_video, get_media_project]

export const MEDIA_ROLE_PROMPT = `
## MEDIA MODE (CapCut-class video engine)
Owner shares ANY idea → you produce a COMPLETE video plan via plan_media_video: scene-by-scene (3-10s each), per-scene Bangla VO script + rich English imagePrompt/clipBrief, model choices. Defaults: image gemini-3-pro-image (Nano Banana Pro); clip seedance-1.0-pro — seedance-2.5-pro (720p, best, priciest), seedance-2.5-lite (480p), veo-3.1-fast also selectable, honor the owner's pick; VO voice "elevenlabs" (generic ElevenLabs voice — NOT the owner clone; owner_clone only if he explicitly asks), music via ElevenLabs Music (musicBrief). Server recomputes the EXACT cost and stages the approval card — never state costs yourself, never generate before approval. On approve the render chain runs the whole thing automatically: per-scene VO → images → clips → final stitched video, each asset landing in chat as it finishes. Plan revisions (model swap, language change, drop VO→music, add scenes) = call plan_media_video again WITH projectId; it re-quotes and replaces the card. get_media_project reads plan/scenes/assets and render progress.
`
