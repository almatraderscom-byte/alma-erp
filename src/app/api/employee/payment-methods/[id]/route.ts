import { NextRequest } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { normalizeAlmaRole } from '@/lib/roles'
import {
  assertBusinessScope,
  clearOtherPrimary,
  logPaymentMethodAudit,
  normalizeBankAccount,
  normalizeMobileNumber,
  paymentMethodDto,
  validateQrImageUrl,
} from '@/lib/employee-payment-method'
import { prisma } from '@/lib/prisma'
import { apiFailure, apiSuccess } from '@/lib/safe-api-response'

type Ctx = { params: { id: string } }

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
    if (normalizeAlmaRole(token.role as string) === 'SUPER_ADMIN' && !token.employeeIdGas) {
      return apiFailure('forbidden', 'System owner accounts cannot edit payout methods.', { status: 403 })
    }

    const row = await prisma.employeePaymentMethod.findUnique({ where: { id: params.id } })
    if (!row || row.userId !== token.sub || row.isArchived) {
      return apiFailure('not_found', 'Payment method not found', { status: 404 })
    }
    assertBusinessScope(String(token.businessAccess || ''), row.businessId)

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const patch: Record<string, unknown> = {}

    if (body.account_holder_name != null) {
      patch.accountHolderName = String(body.account_holder_name).trim()
    }
    if (body.account_number != null) {
      patch.accountNumber =
        row.type === 'MOBILE_BANKING'
          ? normalizeMobileNumber(String(body.account_number))
          : normalizeBankAccount(String(body.account_number))
    }
    if (body.bank_name != null) patch.bankName = String(body.bank_name).trim() || null
    if (body.branch_name != null) patch.branchName = String(body.branch_name).trim() || null
    if (body.routing_number != null) patch.routingNumber = String(body.routing_number).trim() || null
    if (body.provider != null && row.type === 'MOBILE_BANKING') {
      patch.provider = String(body.provider).toUpperCase()
    }
    if (body.usage_type != null && row.type === 'MOBILE_BANKING') {
      patch.usageType = String(body.usage_type).toUpperCase() === 'BUSINESS' ? 'BUSINESS' : 'PERSONAL'
    }
    if (body.qr_image_url !== undefined) {
      patch.qrImageUrl = validateQrImageUrl(body.qr_image_url as string | null)
    }
    if (body.is_primary === true) {
      await clearOtherPrimary(row.userId, row.businessId, row.id)
      patch.isPrimary = true
    }

    const updated = await prisma.employeePaymentMethod.update({
      where: { id: row.id },
      data: patch,
    })

    await logPaymentMethodAudit({
      paymentMethodId: row.id,
      userId: row.userId,
      businessId: row.businessId,
      actorUserId: token.sub,
      action: 'UPDATED',
      detail: { fields: Object.keys(patch) },
    })

    return apiSuccess({ method: paymentMethodDto(updated, { reveal: true }) })
  } catch (e) {
    return apiFailure('payment_method_update_failed', (e as Error).message, { status: 400 })
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })

    const row = await prisma.employeePaymentMethod.findUnique({ where: { id: params.id } })
    if (!row || row.userId !== token.sub) {
      return apiFailure('not_found', 'Payment method not found', { status: 404 })
    }

    const updated = await prisma.employeePaymentMethod.update({
      where: { id: row.id },
      data: {
        isArchived: true,
        archivedAt: new Date(),
        isPrimary: false,
        status: 'ARCHIVED',
      },
    })

    if (row.isPrimary) {
      const next = await prisma.employeePaymentMethod.findFirst({
        where: { userId: row.userId, businessId: row.businessId, isArchived: false, status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' },
      })
      if (next) {
        await prisma.employeePaymentMethod.update({
          where: { id: next.id },
          data: { isPrimary: true },
        })
      }
    }

    await logPaymentMethodAudit({
      paymentMethodId: row.id,
      userId: row.userId,
      businessId: row.businessId,
      actorUserId: token.sub,
      action: 'ARCHIVED',
    })

    return apiSuccess({ method: paymentMethodDto(updated, { reveal: false }) })
  } catch (e) {
    return apiFailure('payment_method_delete_failed', (e as Error).message, { status: 400 })
  }
}
