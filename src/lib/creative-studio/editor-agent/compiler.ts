import type {
  AgentPlanningContext,
  EditorClip,
  EditorJobObservation,
  EditorLocalOperation,
  EditorPendingAction,
  EditorPlanWarning,
  EditorPlanWarningCode,
  EditorTrack,
  EditorVerifiedOutcome,
} from '@/lib/creative-studio/editor-agent/contracts'
import {
  createOperationProposal,
  findEditorClip,
  operationId,
} from '@/lib/creative-studio/editor-agent/operations'

const BANGLA_DIGITS: Record<string, string> = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9',
}

const round = (value: number, precision = 3) => {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export function normalizeAgentInstruction(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[০-৯]/g, (digit) => BANGLA_DIGITS[digit])
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/।/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('bn-BD')
    .slice(0, 4_000)
}

function includesAny(value: string, expressions: RegExp[]): boolean {
  return expressions.some((expression) => expression.test(value))
}

function isNegated(value: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    new RegExp(`(?:do not|don't|never|no)\\s+(?:[\\p{L}-]+\\s+){0,4}${escaped}`, 'iu').test(value)
    || new RegExp(`${escaped}.{0,40}(?:করো না|কোরো না|চালিও না|না করতে|নিষেধ)`, 'iu').test(value)
  )
}

function firstTrack(
  context: AgentPlanningContext,
  kinds: EditorTrack['kind'][],
): EditorTrack | null {
  return context.snapshot.tracks.find((track) => kinds.includes(track.kind)) ?? null
}

function selectedOrFirstClip(
  context: AgentPlanningContext,
  kinds: EditorClip['kind'][],
): { track: EditorTrack; clip: EditorClip; index: number } | null {
  if (context.selectedTrackId && context.selectedClipId) {
    const selected = findEditorClip(context.snapshot, {
      trackId: context.selectedTrackId,
      clipId: context.selectedClipId,
    })
    if (selected && kinds.includes(selected.clip.kind)) return selected
  }
  for (const track of context.snapshot.tracks) {
    const index = track.clips.findIndex((clip) => kinds.includes(clip.kind))
    if (index >= 0) return { track, clip: track.clips[index], index }
  }
  return null
}

function addWarning(
  warnings: EditorPlanWarning[],
  code: EditorPlanWarningCode,
  message: string,
): void {
  if (!warnings.some((warning) => warning.code === code)) {
    warnings.push({ code, message })
  }
}

function baseOperation(
  label: string,
  target: { trackId: string; clipId?: string },
) {
  return {
    id: '',
    label,
    effect: 'local_reversible' as const,
    estimatedCostBdt: 0 as const,
    requiredRole: 'creator' as const,
    target,
  }
}

function pendingProviderAction(
  context: AgentPlanningContext,
  kind: 'paid_generation' | 'voice_generation',
  label: string,
): EditorPendingAction {
  const voice = kind === 'voice_generation' ? context.voice : null
  const provider = voice?.provider ?? context.generationProvider
  const voiceBlockedReason = voice?.revoked
    ? 'voice_revoked'
    : voice && !voice.consented
      ? 'voice_not_consented'
      : null
  const providerBlockedReason = provider && !provider.enabled
    ? 'provider_disabled'
    : null
  const blockedReason = voiceBlockedReason ?? providerBlockedReason
  const estimatedCostBdt = Math.max(
    0,
    Math.round(voice?.estimatedCostBdt ?? provider?.estimatedCostBdt ?? 0),
  )
  return {
    id: '',
    kind,
    label,
    targetIds: [
      context.snapshot.scope.compositionId,
      context.selectedClipId ?? context.selectedTrackId ?? 'composition',
    ],
    requiredRole: 'owner',
    state: blockedReason ? 'blocked' : 'requires_separate_confirmation',
    blockedReason,
    provider: provider
      ? {
          engineId: provider.engineId,
          model: provider.model,
          enabled: provider.enabled,
          payloadDigest: provider.payloadDigest,
        }
      : null,
    voice: voice
      ? {
          versionId: voice.versionId,
          active: voice.active,
          consented: voice.consented,
          revoked: voice.revoked,
        }
      : null,
    destination: null,
    estimatedCostBdt,
    maxCostBdt: Math.max(0, Math.round(voice?.maxCostBdt ?? provider?.maxCostBdt ?? 0)),
  }
}

function parseCaptionText(value: string): string | null {
  const quoted = value.match(
    /(?:caption(?:\s+text)?|ক্যাপশন(?:ের\s+লেখা)?)(?:\s*(?:to|as|=|:|করো|লিখো|দিন))?\s*["']([^"']{1,500})["']/iu,
  )?.[1]
  if (quoted?.trim()) return quoted.trim()

  const direct = value.match(
    /(?:set|change|update)\s+(?:the\s+)?caption(?:\s+text)?\s+(?:to|as)\s+([^.!?]{1,240})/iu,
  )?.[1]
  if (direct?.trim()) return direct.trim()

  const bangla = value.match(
    /ক্যাপশন(?:ের\s+লেখা|টা|টি)?\s+(?:করো|লিখো|দিন|হবে)\s+([^.!?]{1,240})/iu,
  )?.[1]
  return bangla?.trim() || null
}

function parseExplicitSeconds(
  value: string,
  expression: RegExp,
): number | null {
  const match = value.match(expression)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function parseTrimRange(value: string): { startSec: number; endSec: number } | null {
  const match = value.match(
    /(?:trim|ট্রিম)(?:\s+(?:the\s+)?(?:selected\s+)?clip)?[^\d]{0,20}(\d+(?:\.\d+)?)\s*(?:s|sec|second|সেকেন্ড)?\s*(?:to|through|-|–|থেকে)\s*(\d+(?:\.\d+)?)\s*(?:s|sec|second|সেকেন্ড)?/iu,
  )
  if (!match) return null
  const startSec = Number(match[1])
  const endSec = Number(match[2])
  return Number.isFinite(startSec) && Number.isFinite(endSec)
    ? { startSec, endSec }
    : null
}

function parseVolume(value: string): { kind: EditorClip['kind']; volume: number } | null {
  const match = value.match(
    /(music|মিউজিক|voice|ভয়েস|ভয়েস|sfx|এসএফএক্স|original|মূল)[^\d%]{0,48}(\d{1,3})(?:\s*%|\s*percent|\s*শতাংশ)/iu,
  )
  if (!match) return null
  const kind = /music|মিউজিক/iu.test(match[1])
    ? 'music'
    : /voice|ভয়েস|ভয়েস/iu.test(match[1])
      ? 'voice'
      : /sfx|এসএফএক্স/iu.test(match[1])
        ? 'sfx'
        : 'video'
  return { kind, volume: clamp(Number(match[2]) / 100, 0, 1) }
}

function withStableOperationIds(operations: EditorLocalOperation[]): EditorLocalOperation[] {
  return operations.map((operation, index) => ({
    ...operation,
    id: operationId(index, operation.kind, operation.target),
  }))
}

function withStablePendingIds(actions: EditorPendingAction[]): EditorPendingAction[] {
  return actions.map((action, index) => ({
    ...action,
    id: `pending-${String(index + 1).padStart(2, '0')}-${action.kind}`,
  }))
}

export async function compileCreativeAgentInstruction(
  instruction: string,
  context: AgentPlanningContext,
) {
  const normalized = normalizeAgentInstruction(instruction)
  const operations: EditorLocalOperation[] = []
  const pendingActions: EditorPendingAction[] = []
  const warnings: EditorPlanWarning[] = []
  let requiresClarification = false

  if (
    includesAny(normalized, [
      /ignore (?:all|any|the)?\s*(?:previous|prior|system|developer)/iu,
      /reveal (?:the )?(?:system|developer) prompt/iu,
      /bypass (?:policy|approval|permission|role|cost)/iu,
      /(?:নির্দেশ|নিয়ম|নীতি).{0,30}(?:উপেক্ষা|বাইপাস)/iu,
      /prompt injection/iu,
    ])
  ) {
    addWarning(
      warnings,
      'prompt_injection_ignored',
      'Instruction-like policy overrides were ignored; only editor commands were parsed.',
    )
  }

  if (
    includesAny(normalized, [
      /(?:i am|i'm|act as|make me|treat me as).{0,24}(?:owner|admin)/iu,
      /(?:আমি|আমাকে).{0,24}(?:owner|মালিক|admin|অ্যাডমিন)/iu,
      /override.{0,24}(?:role|permission)/iu,
    ])
  ) {
    addWarning(
      warnings,
      'role_claim_ignored',
      'Roles come from the authenticated Studio context, never from prompt text.',
    )
  }

  const captionText = parseCaptionText(normalized)
  if (captionText) {
    const selected = selectedOrFirstClip(context, ['caption'])
    if (!selected) {
      requiresClarification = true
      addWarning(warnings, 'ambiguous_target', 'No caption target is available.')
    } else if (captionText !== (selected.clip.text ?? '')) {
      operations.push({
        ...baseOperation('Update caption text', {
          trackId: selected.track.id,
          clipId: selected.clip.id,
        }),
        kind: 'caption.text.set',
        before: selected.clip.text ?? '',
        after: captionText,
      })
    }
  }

  const firstBeatCaption = includesAny(normalized, [
    /(?:caption|ক্যাপশন).{0,48}(?:first beat|opening beat|প্রথম beat|beat.?এ|বিটে|বিট-এ)/iu,
    /(?:move|bring|আনো|নাও).{0,32}(?:caption|ক্যাপশন).{0,32}(?:beat|বিট)/iu,
  ])
  const explicitCaptionSec = parseExplicitSeconds(
    normalized,
    /(?:caption|ক্যাপশন)[^\d]{0,32}(\d+(?:\.\d+)?)\s*(?:s|sec|second|সেকেন্ড)/iu,
  )
  if (firstBeatCaption || explicitCaptionSec !== null) {
    const selected = selectedOrFirstClip(context, ['caption'])
    if (!selected) {
      requiresClarification = true
      addWarning(warnings, 'ambiguous_target', 'No caption timing target is available.')
    } else {
      const nextStart = round(
        clamp(
          explicitCaptionSec ?? context.firstBeatSec,
          0,
          Math.max(0, context.snapshot.canvas.durationSec - 0.1),
        ),
      )
      const duration = Math.max(0.1, selected.clip.endSec - selected.clip.startSec)
      const nextEnd = round(
        Math.min(context.snapshot.canvas.durationSec, nextStart + duration),
      )
      if (nextStart !== selected.clip.startSec || nextEnd !== selected.clip.endSec) {
        operations.push({
          ...baseOperation('Move caption timing', {
            trackId: selected.track.id,
            clipId: selected.clip.id,
          }),
          kind: 'caption.timing.set',
          before: {
            startSec: selected.clip.startSec,
            endSec: selected.clip.endSec,
          },
          after: { startSec: nextStart, endSec: nextEnd },
        })
      }
    }
  }

  const trimRange = parseTrimRange(normalized)
  const tightenOpening = includesAny(normalized, [
    /(?:tighten|shorten|speed up).{0,32}(?:opening|first shot|opening shot)/iu,
    /(?:opening|first shot|opening shot).{0,32}(?:tighter|shorter|faster)/iu,
    /(?:ওপেনিং|শুরুর শট|প্রথম শট).{0,32}(?:টাইট|ছোট|দ্রুত)/iu,
  ])
  if (trimRange || tightenOpening) {
    const selected = selectedOrFirstClip(context, ['video', 'image'])
    if (!selected) {
      requiresClarification = true
      addWarning(warnings, 'ambiguous_target', 'No visual clip is available to trim.')
    } else {
      const oldDuration = selected.clip.endSec - selected.clip.startSec
      const startSec = trimRange
        ? clamp(trimRange.startSec, selected.clip.startSec, selected.clip.endSec)
        : selected.clip.startSec
      const endSec = trimRange
        ? clamp(trimRange.endSec, selected.clip.startSec, selected.clip.endSec)
        : round(selected.clip.endSec - Math.min(1.2, Math.max(0, oldDuration - 0.2)))
      const sourceStartSec = round(
        selected.clip.sourceStartSec + (startSec - selected.clip.startSec),
      )
      const sourceEndSec = round(
        selected.clip.sourceEndSec - (selected.clip.endSec - endSec),
      )
      if (endSec - startSec < 0.2) {
        requiresClarification = true
        addWarning(warnings, 'ambiguous_target', 'The requested trim would remove the clip.')
      } else {
        operations.push({
          ...baseOperation('Trim opening clip', {
            trackId: selected.track.id,
            clipId: selected.clip.id,
          }),
          kind: 'clip.trim',
          before: {
            startSec: selected.clip.startSec,
            endSec: selected.clip.endSec,
            sourceStartSec: selected.clip.sourceStartSec,
            sourceEndSec: selected.clip.sourceEndSec,
          },
          after: { startSec, endSec, sourceStartSec, sourceEndSec },
        })
      }
    }
  }

  const explicitSplit = parseExplicitSeconds(
    normalized,
    /(?:split|cut|ভাগ|কাট)(?:\s+(?:the\s+)?(?:selected\s+)?clip)?[^\d]{0,24}(?:at|@|এ|তে)?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|second|সেকেন্ড)?/iu,
  ) ?? parseExplicitSeconds(
    normalized,
    /(\d+(?:\.\d+)?)\s*(?:s|sec|second|সেকেন্ড)(?:ে|ের)?[^\n.!?]{0,24}(?:split|cut|ভাগ|কাট)/iu,
  )
  const wantsSplit = includesAny(normalized, [
    /(?:split|cut).{0,32}(?:clip|playhead|here)/iu,
    /(?:ক্লিপ|প্লেহেড|এখানে).{0,32}(?:ভাগ|কাট|split)/iu,
  ])
  if (explicitSplit !== null || wantsSplit) {
    const selected = selectedOrFirstClip(context, ['video', 'image'])
    if (!selected) {
      requiresClarification = true
      addWarning(warnings, 'ambiguous_target', 'No visual clip is selected for split.')
    } else {
      const splitAtSec = round(explicitSplit ?? context.playheadSec)
      if (
        splitAtSec - selected.clip.startSec < 0.2
        || selected.clip.endSec - splitAtSec < 0.2
      ) {
        requiresClarification = true
        addWarning(warnings, 'ambiguous_target', 'Split time is outside the selected clip.')
      } else {
        const splitToken = String(splitAtSec).replace('.', '-')
        operations.push({
          ...baseOperation('Split clip at playhead', {
            trackId: selected.track.id,
            clipId: selected.clip.id,
          }),
          kind: 'clip.split',
          before: {
            clipId: selected.clip.id,
            startSec: selected.clip.startSec,
            endSec: selected.clip.endSec,
          },
          after: {
            leftClipId: selected.clip.id,
            rightClipId: `${selected.clip.id}-split-${splitToken}`,
            splitAtSec,
          },
        })
      }
    }
  }

  const scalePercent = parseExplicitSeconds(
    normalized,
    /(?:scale|size|zoom|স্কেল|সাইজ|জুম)[^\d]{0,20}(\d+(?:\.\d+)?)\s*(?:%|percent|শতাংশ)/iu,
  )
  if (scalePercent !== null) {
    const selected = selectedOrFirstClip(context, ['video', 'image', 'caption'])
    if (!selected) {
      requiresClarification = true
      addWarning(warnings, 'ambiguous_target', 'No visual node is selected for transform.')
    } else {
      operations.push({
        ...baseOperation('Scale selected node', {
          trackId: selected.track.id,
          clipId: selected.clip.id,
        }),
        kind: 'node.transform.set',
        before: { ...selected.clip.transform },
        after: {
          ...selected.clip.transform,
          scale: clamp(scalePercent / 100, 0.1, 4),
        },
      })
    }
  }

  const parsedVolume = parseVolume(normalized)
  const lowerMusic = includesAny(normalized, [
    /(?:lower|reduce|duck).{0,32}(?:the\s+)?music/iu,
    /music.{0,32}(?:lower|quieter|under (?:the )?voice|কম|নিচে)/iu,
    /মিউজিক.{0,32}(?:কম|নিচে|ভয়েসের নিচে|ভয়েসের নিচে)/iu,
  ])
  if (parsedVolume || lowerMusic) {
    const kind = parsedVolume?.kind ?? 'music'
    const selected = selectedOrFirstClip(context, [kind])
    if (!selected) {
      requiresClarification = true
      addWarning(warnings, 'ambiguous_target', `No ${kind} track is available.`)
    } else {
      const after = parsedVolume?.volume ?? round(Math.max(0, selected.clip.volume - 0.06))
      if (after !== selected.clip.volume) {
        operations.push({
          ...baseOperation(`Set ${kind} volume`, {
            trackId: selected.track.id,
            clipId: selected.clip.id,
          }),
          kind: 'track.volume.set',
          before: selected.clip.volume,
          after,
        })
      }
    }
  }

  const moveFirst = includesAny(normalized, [
    /move (?:the )?(?:selected )?clip (?:to )?(?:the )?(?:first|start)/iu,
    /(?:selected|এই)?\s*ক্লিপ(?:টি|টা)?\s*(?:প্রথমে|শুরুতে)\s*(?:নাও|আনো|দাও)/iu,
  ])
  if (moveFirst) {
    const selected = selectedOrFirstClip(context, ['video', 'image'])
    if (!selected) {
      requiresClarification = true
      addWarning(warnings, 'ambiguous_target', 'No clip is selected to reorder.')
    } else if (selected.index !== 0) {
      operations.push({
        ...baseOperation('Move selected clip first', {
          trackId: selected.track.id,
          clipId: selected.clip.id,
        }),
        kind: 'clip.move',
        before: { index: selected.index },
        after: { index: 0 },
      })
    }
  }

  const generationRequested = includesAny(normalized, [
    /\b(?:generate|create|make)\b.{0,48}\b(?:image|video|clip|reel|media)\b/iu,
    /(?:ছবি|ভিডিও|ক্লিপ|রিল).{0,32}(?:তৈরি|বানাও|জেনারেট)/iu,
    /(?:তৈরি|বানাও|জেনারেট).{0,32}(?:ছবি|ভিডিও|ক্লিপ|রিল)/iu,
  ])
  if (
    generationRequested
    && !isNegated(normalized, 'generate')
    && !isNegated(normalized, 'তৈরি')
    && !isNegated(normalized, 'বানাও')
    && !isNegated(normalized, 'paid')
  ) {
    const action = pendingProviderAction(
      context,
      'paid_generation',
      'Generate media for the composition',
    )
    pendingActions.push(action)
    addWarning(
      warnings,
      action.blockedReason === 'provider_disabled'
        ? 'provider_disabled'
        : 'paid_generation_separated',
      action.blockedReason === 'provider_disabled'
        ? 'The selected provider is disabled; no job can be queued.'
        : 'Paid generation was separated from reversible local apply.',
    )
  }

  const voiceRequested = includesAny(normalized, [
    /(?:generate|create|dub|synthesi[sz]e).{0,48}(?:voice|voiceover|owner voice)/iu,
    /(?:ভয়েস|ভয়েস|ডাবিং|কণ্ঠ).{0,32}(?:তৈরি|বানাও|জেনারেট|দাও)/iu,
  ])
  if (
    voiceRequested
    && !isNegated(normalized, 'voice')
    && !isNegated(normalized, 'ভয়েস')
    && !isNegated(normalized, 'ভয়েস')
  ) {
    const action = pendingProviderAction(
      context,
      'voice_generation',
      'Generate owner voice audio',
    )
    pendingActions.push(action)
    if (action.blockedReason === 'voice_revoked') {
      addWarning(warnings, 'voice_revoked', 'The referenced voice version is revoked.')
    } else if (action.blockedReason === 'voice_not_consented') {
      addWarning(warnings, 'voice_not_consented', 'The voice version has no active consent.')
    } else if (action.blockedReason === 'provider_disabled') {
      addWarning(warnings, 'provider_disabled', 'The selected voice provider is disabled.')
    } else {
      addWarning(
        warnings,
        'paid_generation_separated',
        'Voice generation requires a separate owner confirmation.',
      )
    }
  }

  const renderRequested = includesAny(normalized, [
    /\b(?:render|export)\b/iu,
    /(?:রেন্ডার|এক্সপোর্ট)/iu,
  ])
  if (
    renderRequested
    && !isNegated(normalized, 'render')
    && !isNegated(normalized, 'export')
    && !isNegated(normalized, 'রেন্ডার')
    && !isNegated(normalized, 'এক্সপোর্ট')
  ) {
    pendingActions.push({
      id: '',
      kind: 'render_export',
      label: 'Render or export current composition',
      targetIds: [context.snapshot.scope.compositionId],
      requiredRole: 'owner',
      state: 'blocked',
      blockedReason: 'separate_render_required',
      provider: null,
      voice: null,
      destination: 'export',
      estimatedCostBdt: 0,
      maxCostBdt: 0,
    })
    addWarning(
      warnings,
      'render_export_separated',
      'Render/export is a distinct pending action and cannot execute through local apply.',
    )
  }

  const publishRequested = includesAny(normalized, [
    /\b(?:publish|post|schedule)\b.{0,48}\b(?:meta|facebook|instagram|external|reel)?\b/iu,
    /(?:মেটা|ফেসবুক|ইনস্টাগ্রাম|বাইরে).{0,32}(?:পাবলিশ|পোস্ট|শিডিউল)/iu,
    /(?:পাবলিশ|পোস্ট|শিডিউল).{0,32}(?:মেটা|ফেসবুক|ইনস্টাগ্রাম|বাইরে)/iu,
  ])
  if (
    publishRequested
    && !isNegated(normalized, 'publish')
    && !isNegated(normalized, 'post')
    && !isNegated(normalized, 'পাবলিশ')
    && !isNegated(normalized, 'পোস্ট')
  ) {
    pendingActions.push({
      id: '',
      kind: 'external_publish',
      label: 'Publish approved composition externally',
      targetIds: [context.snapshot.scope.compositionId],
      requiredRole: 'owner',
      state: 'blocked',
      blockedReason: 'external_effect_not_allowed',
      provider: null,
      voice: null,
      destination: 'meta',
      estimatedCostBdt: 0,
      maxCostBdt: 0,
    })
    addWarning(
      warnings,
      'external_publish_separated',
      'External publish is forbidden in local apply and remains separately owner-gated.',
    )
  }

  if (operations.length === 0 && pendingActions.length === 0 && !requiresClarification) {
    requiresClarification = true
    addWarning(
      warnings,
      'unsupported_instruction',
      'No deterministic editor command matched; clarify the target and value.',
    )
  }

  return createOperationProposal({
    origin: 'agent',
    snapshot: context.snapshot,
    actor: context.actor,
    instruction,
    normalizedInstruction: normalized,
    operations: withStableOperationIds(operations),
    pendingActions: withStablePendingIds(pendingActions),
    warnings,
    requiresClarification,
  })
}

export function verifyEditorJobObservation(
  observation: EditorJobObservation,
): EditorVerifiedOutcome {
  if (observation.status === 'queued' || observation.status === 'running') {
    return {
      complete: false,
      artifact: null,
      status: observation.status,
      reason: 'not_finished',
    }
  }
  if (observation.status === 'failed') {
    return {
      complete: false,
      artifact: null,
      status: 'failed',
      reason: 'failed',
    }
  }
  if (observation.status === 'needs_review') {
    return {
      complete: false,
      artifact: null,
      status: 'needs_review',
      reason: 'ambiguous_result',
    }
  }
  if (!observation.artifact) {
    return {
      complete: false,
      artifact: null,
      status: 'needs_review',
      reason: 'artifact_missing',
    }
  }
  return {
    complete: true,
    artifact: observation.artifact,
    status: 'executed',
  }
}
