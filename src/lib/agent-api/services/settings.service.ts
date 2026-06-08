import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_BUSINESS_ID } from '@/lib/agent-api/constants'
import type { Prisma } from '@prisma/client'

async function getOrCreateSettings() {
  return prisma.agentSettings.upsert({
    where: { id: 'global' },
    create: { id: 'global' },
    update: {},
  })
}

async function bumpVersion() {
  const row = await prisma.agentSettings.update({
    where: { id: 'global' },
    data: { settingsVersion: { increment: 1 } },
  })
  return row.settingsVersion
}

export async function getSettings() {
  const [agent, ops, fine] = await Promise.all([
    getOrCreateSettings(),
    prisma.telegramOpsSetting.findUnique({ where: { businessId: DEFAULT_AGENT_BUSINESS_ID } }),
    prisma.tradingVolumeTargetSettings.findUnique({ where: { businessId: DEFAULT_AGENT_BUSINESS_ID } }),
  ])
  return {
    settingsVersion: agent.settingsVersion,
    businessHours: agent.businessHours ?? {
      officeStartMinutes: ops?.officeStartMinutes ?? 540,
      officeEndMinutes: 1260,
    },
    holidays: agent.holidays ?? [],
    lateThresholdMinutes: agent.lateThresholdMinutes ?? ops?.gracePeriodMinutes ?? 15,
    finePolicy: agent.finePolicy ?? {
      autoPenaltyEnabled: fine?.autoPenaltyEnabled ?? false,
      defaultPenaltyBdt: Number(fine?.defaultPenaltyBdt ?? 500),
    },
  }
}

export async function patchBusinessHours(body: { officeStartMinutes: number; officeEndMinutes: number }) {
  await prisma.telegramOpsSetting.upsert({
    where: { businessId: DEFAULT_AGENT_BUSINESS_ID },
    create: {
      businessId: DEFAULT_AGENT_BUSINESS_ID,
      officeStartMinutes: body.officeStartMinutes,
    },
    update: { officeStartMinutes: body.officeStartMinutes },
  })
  await prisma.agentSettings.update({
    where: { id: 'global' },
    data: { businessHours: body, settingsVersion: { increment: 1 } },
  })
  return { status: 'updated', settingsVersion: await bumpVersion() }
}

export async function patchHolidays(holidays: string[]) {
  await prisma.agentSettings.update({
    where: { id: 'global' },
    data: { holidays, settingsVersion: { increment: 1 } },
  })
  return { status: 'updated', settingsVersion: await bumpVersion(), holidays }
}

export async function patchLateThreshold(minutes: number) {
  await prisma.telegramOpsSetting.upsert({
    where: { businessId: DEFAULT_AGENT_BUSINESS_ID },
    create: { businessId: DEFAULT_AGENT_BUSINESS_ID, gracePeriodMinutes: minutes },
    update: { gracePeriodMinutes: minutes },
  })
  await prisma.agentSettings.update({
    where: { id: 'global' },
    data: { lateThresholdMinutes: minutes, settingsVersion: { increment: 1 } },
  })
  return { status: 'updated', settingsVersion: await bumpVersion(), lateThresholdMinutes: minutes }
}

export async function patchFinePolicy(body: Record<string, unknown>) {
  await prisma.tradingVolumeTargetSettings.upsert({
    where: { businessId: DEFAULT_AGENT_BUSINESS_ID },
    create: {
      businessId: DEFAULT_AGENT_BUSINESS_ID,
      autoPenaltyEnabled: Boolean(body.autoPenaltyEnabled),
      defaultPenaltyBdt: Number(body.defaultPenaltyBdt ?? 500),
    },
    update: {
      autoPenaltyEnabled: body.autoPenaltyEnabled !== undefined ? Boolean(body.autoPenaltyEnabled) : undefined,
      defaultPenaltyBdt: body.defaultPenaltyBdt !== undefined ? Number(body.defaultPenaltyBdt) : undefined,
    },
  })
  await prisma.agentSettings.update({
    where: { id: 'global' },
    data: { finePolicy: body as Prisma.InputJsonValue, settingsVersion: { increment: 1 } },
  })
  return { status: 'updated', settingsVersion: await bumpVersion() }
}
