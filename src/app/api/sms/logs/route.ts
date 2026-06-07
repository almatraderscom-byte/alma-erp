import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getJwt, requireRoles } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { smsStats } from '@/lib/sms/queue'
import {
  SMS_TYPE_CATALOG,
  defaultEnabledTypesJson,
  parseEnabledTypesJson,
  serializeEnabledTypes,
  smsSettingDto,
} from '@/lib/sms/settings'
import type { SmsType } from '@/lib/sms/types'

export async function GET(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied
  const url = new URL(req.url)
  const businessId = resolveBusinessId(url.searchParams.get('business_id'))
  const status = url.searchParams.get('status')
  const [logs, stats, setting] = await Promise.all([
    prisma.smsLog.findMany({
      where: {
        OR: [{ businessId }, { businessId: null }],
        ...(status && status !== 'ALL' ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
    }),
    smsStats(),
    prisma.smsSetting.findUnique({ where: { businessId } }),
  ])
  return NextResponse.json({
    logs,
    stats,
    catalog: SMS_TYPE_CATALOG,
    setting: smsSettingDto(
      businessId,
      setting,
      process.env.SMS_SENDER_ID || '',
    ),
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function PATCH(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN'])
  if (denied) return denied
  const token = await getJwt(req)
  const body = await req.json().catch(() => ({})) as {
    business_id?: string
    enabled?: boolean
    senderId?: string | null
    enabled_types?: SmsType[]
  }
  const businessId = resolveBusinessId(body.business_id)
  const existing = await prisma.smsSetting.findUnique({ where: { businessId } })

  const enabledTypesJson = Array.isArray(body.enabled_types)
    ? serializeEnabledTypes(body.enabled_types)
    : existing?.enabledTypesJson || defaultEnabledTypesJson()

  const setting = await prisma.smsSetting.upsert({
    where: { businessId },
    create: {
      businessId,
      enabled: body.enabled === true,
      senderId: String(body.senderId || '').trim() || null,
      enabledTypesJson,
      updatedById: token?.sub || null,
    },
    update: {
      ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
      ...(body.senderId !== undefined
        ? { senderId: String(body.senderId || '').trim() || null }
        : {}),
      ...(Array.isArray(body.enabled_types) ? { enabledTypesJson } : {}),
      updatedById: token?.sub || null,
    },
  })

  return NextResponse.json({
    ok: true,
    setting: smsSettingDto(
      businessId,
      setting,
      process.env.SMS_SENDER_ID || '',
    ),
    enabledTypes: parseEnabledTypesJson(setting.enabledTypesJson),
  })
}
