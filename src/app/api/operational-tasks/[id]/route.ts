import { NextRequest, NextResponse } from 'next/server'
import { getJwt, forbidViewerWrite } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { resendSpotlight } from '@/lib/operational-tasks'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const denied = await forbidViewerWrite(req)
  if (denied) return denied
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: 'archive' | 'resend'
    assignment_id?: string
    title?: string
    description?: string
    priority?: string
    banner_image_url?: string | null
    deadline?: string | null
    acknowledgment_required?: boolean
    allow_dismiss?: boolean
    show_on_check_in?: boolean
  }

  if (body.action === 'archive') {
    await prisma.operationalTask.update({
      where: { id: params.id },
      data: { status: 'ARCHIVED' },
    })
    await prisma.operationalTaskAssignment.updateMany({
      where: { taskId: params.id, status: { not: 'COMPLETED' } },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    })
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'resend' && body.assignment_id) {
    await resendSpotlight(body.assignment_id)
    return NextResponse.json({ ok: true })
  }

  const data: Record<string, unknown> = {}
  if (body.title) data.title = String(body.title).trim()
  if (body.description) data.description = String(body.description).trim()
  if (body.priority) data.priority = body.priority
  if (body.banner_image_url !== undefined) data.bannerImageUrl = body.banner_image_url
  if (body.deadline !== undefined) data.deadline = body.deadline ? new Date(body.deadline) : null
  if (body.acknowledgment_required !== undefined) data.acknowledgmentRequired = body.acknowledgment_required
  if (body.allow_dismiss !== undefined) data.allowDismiss = body.allow_dismiss
  if (body.show_on_check_in !== undefined) data.showOnCheckIn = body.show_on_check_in

  if (Object.keys(data).length) {
    await prisma.operationalTask.update({ where: { id: params.id }, data })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const token = await getJwt(_req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  await prisma.operationalTask.update({
    where: { id: params.id },
    data: { status: 'ARCHIVED' },
  })
  return NextResponse.json({ ok: true })
}
