import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrl } from '@/agent/lib/storage'
import { sendOwnerApprovalCard } from '@/agent/lib/telegram-owner-notify'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type VideoReelGatePayload = {
  storagePath: string
  productCode?: string | null
  aspect?: string
  durationSec?: number
  conversationId?: string | null
  sourceActionId?: string | null
}

export async function createVideoReelGate(args: VideoReelGatePayload): Promise<{ gateId: string; summary: string }> {
  let previewUrl = ''
  try {
    previewUrl = await agentStorageSignedUrl(args.storagePath, 3600)
  } catch {
    previewUrl = args.storagePath
  }

  const summary =
    '🎬 Product Reel — owner approval\n' +
    (args.productCode ? `প্রোডাক্ট: ${args.productCode}\n` : '') +
    `Aspect: ${args.aspect ?? '9:16'} | Duration: ~${args.durationSec ?? 6}s\n\n` +
    `Preview: ${previewUrl}\n\n` +
    'Approve করলে Reels/Stories-এ post করার জন্য ready — auto-post হবে না।'

  const gate = await db.agentPendingAction.create({
    data: {
      conversationId: args.conversationId ?? null,
      type: 'video_reel_gate',
      payload: args,
      summary,
      costEstimate: 0,
      status: 'pending',
    },
  })

  await sendOwnerApprovalCard({
    summary,
    pendingActionId: gate.id,
  }).catch(() => {})

  return { gateId: gate.id, summary }
}
