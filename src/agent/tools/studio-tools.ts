/**
 * Phase A1 — the head's door into the Creative Studio.
 *
 * "ei panjabir baba-chele set banao" / "ei video ta offer reel banao" /
 * "আমার ভয়েসে এই লাইনটা বলাও" all flow through ONE tool that wraps the same
 * engines the Studio UI uses. The agent picks NOTHING creative — the Brand
 * Recipe (kv `studio_brand_recipe`, owner-tunable, no redeploy) and the hard
 * presets decide; the tool just routes.
 *
 * Self-verification contract: this tool QUEUES work and returns pendingActionIds
 * + a check_studio_job action. The head must poll check_studio_job and only
 * claim success once status is `executed` with an artifact — never before
 * (claim-verifier discipline).
 */
import { prisma } from '@/lib/prisma'
import { runCreativeStudio } from '@/lib/creative-studio/create-run'
import { getVideoRecipe, VIDEO_RECIPES } from '@/lib/creative-studio/video-recipes'
import { buildMusicPrompt, buildWishSong, audioCostBdt, MUSIC_STYLES } from '@/lib/creative-studio/audio-lab'
import { agentStorageSignedUrl } from '@/agent/lib/storage'
import { checkCreativeCompliance } from '@/agent/lib/marketing/creative-strategy'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const RECIPE_KEY = 'studio_brand_recipe'

type BrandRecipe = {
  /** default family preset when the owner just says "set banao" */
  defaultFamilyPreset?: string
  /** default reel recipe for his shot videos */
  defaultVideoRecipe?: string
  /** default music style for the audio lab */
  defaultMusicStyle?: string
  /** default output aspect for reels */
  defaultAspect?: string
}

async function readBrandRecipe(): Promise<BrandRecipe> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: RECIPE_KEY } })
    const parsed = row ? JSON.parse(row.value) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const run_creative_studio: AgentTool = {
  name: 'run_creative_studio',
  description:
    'Run the Creative Studio from chat — the SAME deterministic engines as the Studio UI, zero LLM creative judgment. ' +
    'Actions: family_set (product image → বাবা-ছেলে/কাপল etc. accuracy chain), reel (product/family image → Veo reel; 16s+ = multi-clip), ' +
    'edit_video (owner-uploaded shoot path → recipe reel with optional captions/music/voiceover), music / wish_song / owner_voice / sfx (Audio Lab), ' +
    'set_brand_recipe / get_brand_recipe (owner-tunable defaults the agent MUST follow instead of its own taste). ' +
    'Every action QUEUES a job and returns pendingActionIds — you MUST poll with check_studio_job and only tell the owner it is done ' +
    'when status=executed with an artifact URL. Costs: reels ~$0.15/s (Veo), audio shown in result; images ~$0.25-0.70/set.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['family_set', 'reel', 'edit_video', 'music', 'wish_song', 'owner_voice', 'sfx', 'get_brand_recipe', 'set_brand_recipe'],
        description: 'Which Studio engine to run',
      },
      productImagePath: { type: 'string', description: 'agent-files path of the product/source image (family_set, reel)' },
      familyPreset: {
        type: 'string',
        enum: ['father_son', 'mother_son', 'mother_daughter', 'father_daughter', 'couple', 'full_family'],
        description: 'family_set: which pair — omit to use the Brand Recipe default',
      },
      videoPath: { type: 'string', description: 'edit_video: studio-video/uploads/... path of the owner\'s shoot' },
      videoRecipeId: { type: 'string', enum: VIDEO_RECIPES.map((r) => r.id), description: 'edit_video: omit → Brand Recipe default' },
      targetSec: { type: 'number', description: 'edit_video: 15/30/60 · reel: 6/8 single clip, 16/24 multi-clip' },
      captions: { type: 'boolean', description: 'edit_video: burn Bangla captions' },
      voiceoverText: { type: 'string', description: 'edit_video: owner-approved line (never write one yourself without telling him)' },
      text: { type: 'string', description: 'owner_voice / sfx: the exact text' },
      styleId: { type: 'string', enum: MUSIC_STYLES.map((s) => s.id), description: 'music: omit → Brand Recipe default' },
      occasionId: { type: 'string', enum: ['birthday', 'anniversary', 'eid'], description: 'wish_song: which occasion template' },
      name: { type: 'string', description: 'wish_song: the person\'s name (goes into the FIXED lyric template)' },
      seconds: { type: 'number', description: 'music/sfx: clip length in seconds' },
      recipe: { type: 'object', description: 'set_brand_recipe: {defaultFamilyPreset?, defaultVideoRecipe?, defaultMusicStyle?, defaultAspect?}' },
    },
    required: ['action'],
  },
  handler: async (input) => {
    const action = String(input.action ?? '')
    const brand = await readBrandRecipe()

    // Phase 44 gate: every free text that can reach a public asset (voiceover,
    // owner_voice/sfx text, music prompt seed) passes the brand/Islamic +
    // honesty gate BEFORE a job is queued. Blocked = fix the copy first.
    {
      const freeText = [input.voiceoverText, input.text].filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      for (const t of freeText) {
        const gate = checkCreativeCompliance(t)
        if (!gate.ok) {
          return {
            success: false,
            error:
              'কপি gate-এ আটকেছে: ' +
              gate.violations.filter((v) => v.severity === 'block').map((v) => `${v.rule} ("${v.match}")`).join('; ') +
              ' — টেক্সট ঠিক করে আবার পাঠান।',
          }
        }
      }
    }

    if (action === 'get_brand_recipe') return { success: true, data: { recipe: brand } }

    if (action === 'set_brand_recipe') {
      const patch = (input.recipe ?? {}) as BrandRecipe
      const next = { ...brand, ...patch }
      await db.agentKvSetting.upsert({
        where: { key: RECIPE_KEY },
        update: { value: JSON.stringify(next) },
        create: { key: RECIPE_KEY, value: JSON.stringify(next) },
      })
      return { success: true, data: { recipe: next } }
    }

    if (action === 'family_set') {
      const productImagePath = String(input.productImagePath ?? '')
      if (!productImagePath) return { success: false, error: 'productImagePath required (owner-uploaded product photo)' }
      const preset = String(input.familyPreset ?? brand.defaultFamilyPreset ?? 'father_son')
      const result = await runCreativeStudio({
        mode: 'product_to_model',
        productImagePath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        familyPreset: preset as any,
      })
      return {
        success: true,
        data: {
          queued: result.jobs.map((j) => ({ pendingActionId: j.pendingActionId, label: j.label })),
          note: 'Jobs queued — poll check_studio_job until executed; only then report done with the artifact.',
        },
      }
    }

    if (action === 'reel') {
      const src = String(input.productImagePath ?? '')
      if (!src) return { success: false, error: 'productImagePath required' }
      const durationSec = Number(input.seconds ?? input.targetSec ?? 6)
      const result = await runCreativeStudio({
        mode: 'image_to_video',
        sourceImagePath: src,
        durationSec,
        aspectRatio: brand.defaultAspect === '16:9' ? '16:9' : '9:16',
      })
      return {
        success: true,
        data: {
          queued: result.jobs.map((j) => ({ pendingActionId: j.pendingActionId, label: j.label })),
          costNote: `~$${(0.15 * (durationSec >= 16 ? Math.ceil(durationSec / 8) * 8 : durationSec)).toFixed(2)} Veo`,
        },
      }
    }

    if (action === 'edit_video') {
      const videoPath = String(input.videoPath ?? '')
      if (!videoPath.startsWith('studio-video/uploads/')) {
        return { success: false, error: 'videoPath must be an uploaded shoot (studio-video/uploads/...) — list them via the Studio Video tab' }
      }
      const recipe = getVideoRecipe(String(input.videoRecipeId ?? brand.defaultVideoRecipe ?? 'product_showcase'))
      if (!recipe) return { success: false, error: 'invalid videoRecipeId' }
      const targetSec = recipe.targets.includes(Number(input.targetSec)) ? Number(input.targetSec) : recipe.defaultTarget
      const row = await db.agentPendingAction.create({
        data: {
          conversationId: null,
          type: 'video_edit',
          payload: {
            videoEdit: true,
            creativeStudio: true,
            skipTelegramCard: true,
            studioMode: 'video_edit',
            provider: 'ffmpeg',
            videoPath,
            videoName: 'chat-request',
            recipeId: recipe.id,
            targetSec,
            aspect: brand.defaultAspect === '16:9' ? '16:9' : '9:16',
            captions: input.captions === true,
            audioMode: 'original',
            voiceoverText: String(input.voiceoverText ?? '').trim().slice(0, 220) || null,
            stings: false,
          },
          summary: `🎬 ${recipe.labelBn} রিল ${targetSec}s (chat)`,
          costEstimate: 0,
          status: 'approved',
        },
      })
      return { success: true, data: { queued: [{ pendingActionId: row.id, label: `${recipe.labelBn} ${targetSec}s` }] } }
    }

    // ── Audio Lab actions (same payloads the owner-auth route builds) ────────
    if (['music', 'wish_song', 'owner_voice', 'sfx'].includes(action)) {
      const seconds = Math.min(120, Math.max(3, Number(input.seconds ?? 30)))
      const payload: Record<string, unknown> = {
        audioLab: true,
        creativeStudio: true,
        skipTelegramCard: true,
        studioMode: 'audio_lab',
        provider: 'elevenlabs',
        kind: action,
        seconds,
        costUsd: audioCostBdt(action as 'music', seconds) / 125,
      }
      let summary = ''
      if (action === 'music') {
        payload.prompt = buildMusicPrompt(String(input.styleId ?? brand.defaultMusicStyle ?? 'celebration'), String(input.text ?? ''))
        summary = `🎵 মিউজিক (chat) ${seconds}s`
      } else if (action === 'wish_song') {
        const built = buildWishSong(String(input.occasionId ?? 'birthday'), String(input.name ?? ''))
        payload.prompt = built.prompt
        payload.lyrics = built.lyrics
        summary = `🎁 উইশ গান (chat) — ${String(input.name ?? '').slice(0, 30)}`
      } else if (action === 'owner_voice') {
        const text = String(input.text ?? '').trim().slice(0, 600)
        if (!text) return { success: false, error: 'text required' }
        payload.text = text
        summary = `🎙️ আমার ভয়েসে (chat)`
      } else {
        const text = String(input.text ?? '').trim().slice(0, 200)
        if (!text) return { success: false, error: 'text required' }
        payload.text = text
        payload.seconds = Math.min(10, seconds)
        summary = `🔊 SFX (chat)`
      }
      const row = await db.agentPendingAction.create({
        data: { conversationId: null, type: 'audio_gen', payload, summary, costEstimate: Number(payload.costUsd), status: 'approved' },
      })
      return {
        success: true,
        data: { queued: [{ pendingActionId: row.id, label: summary }], costBdt: audioCostBdt(action as 'music', seconds) },
      }
    }

    return { success: false, error: `unknown action: ${action}` }
  },
}

const check_studio_job: AgentTool = {
  name: 'check_studio_job',
  description:
    'Poll a Creative Studio job queued by run_creative_studio. Returns status + a signed artifact URL when executed. ' +
    'NEVER tell the owner a studio job is done without an executed status + artifact from THIS tool.',
  input_schema: {
    type: 'object' as const,
    properties: { pendingActionId: { type: 'string', description: 'Id returned when the job was queued' } },
    required: ['pendingActionId'],
  },
  handler: async (input) => {
    const row = await db.agentPendingAction.findUnique({ where: { id: String(input.pendingActionId ?? '') } })
    if (!row) return { success: false, error: 'not_found' }
    const result = (row.result ?? {}) as Record<string, unknown>
    const payload = (row.payload ?? {}) as Record<string, unknown>
    const storagePath = (result.storagePath ?? result.brandedPath) as string | undefined
    let artifactUrl: string | null = null
    if (row.status === 'executed' && storagePath) {
      artifactUrl = await agentStorageSignedUrl(storagePath, 3600).catch(() => null)
    }
    const progress = payload._videoProgress as { step?: number; total?: number; labelBn?: string } | undefined
    return {
      success: true,
      data: {
        status: row.status,
        summary: row.summary,
        progress: progress ? `ধাপ ${progress.step}/${progress.total}: ${progress.labelBn}` : null,
        storagePath: storagePath ?? null,
        artifactUrl,
        error: (result.error ?? row.error ?? null) as string | null,
      },
    }
  },
}

export const STUDIO_TOOLS: AgentTool[] = [run_creative_studio, check_studio_job]
