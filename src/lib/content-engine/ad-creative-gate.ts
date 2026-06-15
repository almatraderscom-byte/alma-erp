import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrl } from '@/agent/lib/storage'
import { sendOwnerApprovalCard } from '@/agent/lib/telegram-owner-notify'
import {
  renderAndStoreAdCreative,
  type AdAspect,
  type AdCreativeSpec,
  type AdTemplate,
} from '@/lib/content-engine/ad-creative'
import type { BrandTheme } from '@/lib/content-engine/brand-identity'
import type { AdCopyAngle } from '@/lib/content-engine/caption'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type AdCreativeItem = {
  id: string
  angle: string
  aspect: AdAspect
  imagePath: string
  hookBn: string
  primaryTextBn: string
  ctaBn: string
  template: AdTemplate
}

export type AdCreativeGatePayload = {
  productCode: string
  template: AdTemplate
  theme: BrandTheme
  baseImagePath: string
  creatives: AdCreativeItem[]
  conversationId?: string | null
}

export type AdCreativeKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

export function buildAdCreativeKeyboard(
  gateId: string,
  payload: AdCreativeGatePayload,
): AdCreativeKeyboard {
  const rows: AdCreativeKeyboard['inline_keyboard'] = []
  for (const c of payload.creatives) {
    rows.push([
      {
        text: `🔄 ${c.angle.slice(0, 12)} (${c.aspect})`,
        callback_data: `ad_regen:${gateId}:${c.id}`,
      },
    ])
  }
  rows.push([
    { text: '✅ Approve creatives', callback_data: `approve:${gateId}` },
    { text: '❌ বাতিল', callback_data: `reject:${gateId}` },
  ])
  return { inline_keyboard: rows }
}

export async function buildAdCreativeSummary(payload: AdCreativeGatePayload): Promise<string> {
  const lines = [
    '🎯 Ad Creative Gate — owner approval',
    `প্রোডাক্ট: ${payload.productCode}`,
    `টেমপ্লেট: ${payload.template} | থিম: ${payload.theme}`,
    '',
    'ক্রিয়েটিভ:',
  ]
  for (const c of payload.creatives) {
    try {
      const url = await agentStorageSignedUrl(c.imagePath, 3600)
      lines.push(`• **${c.angle}** (${c.aspect}): ${c.hookBn}`)
      lines.push(`  ![${c.id}](${url})`)
    } catch {
      lines.push(`• ${c.angle} (${c.aspect}): ${c.imagePath}`)
    }
  }
  lines.push('', 'Approve করলে ডাউনলোড/Ads-এ ব্যবহারের জন্য ready — কিছু auto-post হবে না।')
  return lines.join('\n')
}

export async function createAdCreativeGate(args: {
  productCode: string
  template: AdTemplate
  theme: BrandTheme
  baseImagePath: string
  specs: Array<{ spec: AdCreativeSpec; copy: AdCopyAngle; aspect: AdAspect }>
  conversationId?: string | null
}): Promise<{ gateId: string; creatives: AdCreativeItem[]; summary: string }> {
  const creatives: AdCreativeItem[] = []

  for (const { spec, copy, aspect } of args.specs) {
    const id = randomUUID().slice(0, 8)
    const imagePath = await renderAndStoreAdCreative(
      args.baseImagePath,
      { ...spec, aspect, headlineBn: copy.hookBn || spec.headlineBn },
      `${args.productCode}-${id}-${aspect.replace(':', '')}`,
    )
    creatives.push({
      id,
      angle: copy.angle,
      aspect,
      imagePath,
      hookBn: copy.hookBn,
      primaryTextBn: copy.primaryTextBn,
      ctaBn: copy.ctaBn,
      template: spec.template,
    })
  }

  const payload: AdCreativeGatePayload = {
    productCode: args.productCode,
    template: args.template,
    theme: args.theme,
    baseImagePath: args.baseImagePath,
    creatives,
    conversationId: args.conversationId ?? null,
  }

  const summary = await buildAdCreativeSummary(payload)

  const gate = await db.agentPendingAction.create({
    data: {
      conversationId: args.conversationId ?? null,
      type: 'ad_creative_gate',
      payload,
      summary,
      costEstimate: creatives.length * 0.15,
      status: 'pending',
    },
  })

  await sendOwnerApprovalCard({
    summary,
    pendingActionId: gate.id,
    reply_markup: buildAdCreativeKeyboard(gate.id, payload),
  }).catch(() => {})

  return { gateId: gate.id, creatives, summary }
}

export async function regenerateAdCreativeItem(
  gateId: string,
  creativeId: string,
): Promise<{ summary: string; imagePath: string }> {
  const gate = await db.agentPendingAction.findUnique({ where: { id: gateId } })
  if (!gate || gate.type !== 'ad_creative_gate') throw new Error('invalid_ad_gate')

  const payload = gate.payload as AdCreativeGatePayload
  const item = payload.creatives.find((c) => c.id === creativeId)
  if (!item) throw new Error('creative_not_found')

  const spec: AdCreativeSpec = {
    template: item.template,
    theme: payload.theme,
    headlineBn: item.hookBn,
    ctaBn: item.ctaBn,
    aspect: item.aspect,
  }

  const imagePath = await renderAndStoreAdCreative(
    payload.baseImagePath,
    spec,
    `${payload.productCode}-${creativeId}-regen-${Date.now()}`,
  )
  item.imagePath = imagePath

  const summary = await buildAdCreativeSummary(payload)
  await db.agentPendingAction.update({
    where: { id: gateId },
    data: { payload, summary },
  })

  await sendOwnerApprovalCard({
    summary: `🔄 রিজেনারেট: ${item.angle}\n\n${summary}`,
    reply_markup: buildAdCreativeKeyboard(gateId, payload),
  }).catch(() => {})

  return { summary, imagePath }
}

export async function approveAdCreativeGate(gateId: string): Promise<{ creatives: AdCreativeItem[] }> {
  const gate = await db.agentPendingAction.findUnique({ where: { id: gateId } })
  if (!gate || gate.type !== 'ad_creative_gate') throw new Error('invalid_ad_gate')

  const claimed = await db.agentPendingAction.updateMany({
    where: { id: gateId, status: 'pending' },
    data: { status: 'approved', resolvedAt: new Date() },
  })
  if (claimed.count === 0) throw new Error('already_resolved')

  const payload = gate.payload as AdCreativeGatePayload
  return { creatives: payload.creatives }
}
