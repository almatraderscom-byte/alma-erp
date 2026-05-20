import { NextRequest } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { normalizeAlmaRole } from '@/lib/roles'
import {
  clearOtherPrimary,
  listPaymentMethodsForUser,
  logPaymentMethodAudit,
  paymentMethodDto,
} from '@/lib/employee-payment-method'
import { prisma } from '@/lib/prisma'
import { apiFailure, apiSuccess } from '@/lib/safe-api-response'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
    if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
      return apiFailure('forbidden', 'Super Admin only', { status: 403 })
    }

    const userId = req.nextUrl.searchParams.get('user_id')?.trim()
    const businessId = resolveBusinessId(req.nextUrl.searchParams.get('business_id'))
    if (!userId) return apiFailure('invalid_request', 'user_id required', { status: 400 })

    const methods = await listPaymentMethodsForUser(userId, businessId, true)
    const audit = await prisma.employeePaymentMethodAuditLog.findMany({
      where: { userId, businessId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })

    return apiSuccess({
      methods,
      audit: audit.map(a => ({
        id: a.id,
        action: a.action,
        actorUserId: a.actorUserId,
        paymentMethodId: a.paymentMethodId,
        createdAt: a.createdAt.toISOString(),
        detail: a.detailJson ? JSON.parse(a.detailJson) : null,
      })),
    })
  } catch (e) {
    return apiFailure('admin_payment_methods_failed', (e as Error).message, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
    if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
      return apiFailure('forbidden', 'Super Admin only', { status: 403 })
    }

    const body = (await req.json().catch(() => ({}))) as {
      id?: string
      action?: 'VERIFY' | 'UNVERIFY' | 'DISABLE' | 'ENABLE' | 'SUSPICIOUS' | 'SET_PRIMARY' | 'UPDATE'
      suspicious_note?: string
      account_holder_name?: string
      account_number?: string
    }

    if (!body.id) return apiFailure('invalid_request', 'id required', { status: 400 })

    const row = await prisma.employeePaymentMethod.findUnique({ where: { id: body.id } })
    if (!row || row.isArchived) return apiFailure('not_found', 'Payment method not found', { status: 404 })

    const action = body.action || 'UPDATE'
    const data: Record<string, unknown> = {}

    if (action === 'VERIFY') {
      data.isVerified = true
      data.verifiedAt = new Date()
      data.verifiedById = token.sub
      data.status = 'ACTIVE'
    } else if (action === 'UNVERIFY') {
      data.isVerified = false
      data.verifiedAt = null
      data.verifiedById = null
    } else if (action === 'DISABLE') {
      data.status = 'DISABLED'
      data.isPrimary = false
    } else if (action === 'ENABLE') {
      data.status = 'ACTIVE'
    } else if (action === 'SUSPICIOUS') {
      data.status = 'SUSPICIOUS'
      data.suspiciousNote = String(body.suspicious_note || '').slice(0, 500) || 'Flagged by Super Admin'
    } else if (action === 'SET_PRIMARY') {
      await clearOtherPrimary(row.userId, row.businessId, row.id)
      data.isPrimary = true
      data.status = 'ACTIVE'
    }

    if (body.account_holder_name) data.accountHolderName = body.account_holder_name.trim()
    if (body.account_number) data.accountNumber = body.account_number.trim()

    const updated = await prisma.employeePaymentMethod.update({
      where: { id: row.id },
      data,
    })

    await logPaymentMethodAudit({
      paymentMethodId: row.id,
      userId: row.userId,
      businessId: row.businessId,
      actorUserId: token.sub,
      action: `ADMIN_${action}`,
      detail: { status: updated.status, isVerified: updated.isVerified },
    })

    return apiSuccess({ method: paymentMethodDto(updated, { reveal: true }) })
  } catch (e) {
    return apiFailure('admin_payment_method_patch_failed', (e as Error).message, { status: 400 })
  }
}
