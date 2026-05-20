import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { businessAllowed } from '@/lib/business-access'
import { normalizeAlmaRole } from '@/lib/roles'
import {
  assertBusinessScope,
  clearOtherPrimary,
  listPaymentMethodsForUser,
  logPaymentMethodAudit,
  normalizeBankAccount,
  normalizeMobileNumber,
  paymentMethodDto,
  validateQrImageUrl,
} from '@/lib/employee-payment-method'
import { prisma } from '@/lib/prisma'
import { apiFailure, apiSuccess } from '@/lib/safe-api-response'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })

    const businessId = resolveBusinessId(req.nextUrl.searchParams.get('business_id'))
    assertBusinessScope(String(token.businessAccess || ''), businessId)

    const methods = await listPaymentMethodsForUser(token.sub, businessId, false)
    return apiSuccess({ methods })
  } catch (e) {
    return apiFailure('payment_methods_list_failed', (e as Error).message, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
    const role = normalizeAlmaRole(token.role as string)
    if (role === 'SUPER_ADMIN' && !token.employeeIdGas) {
      return apiFailure('forbidden', 'System owner accounts do not manage personal payout methods.', { status: 403 })
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const businessId = resolveBusinessId(String(body.business_id || ''))
    assertBusinessScope(String(token.businessAccess || ''), businessId)

    const type = String(body.type || '') as 'MOBILE_BANKING' | 'BANK_ACCOUNT'
    if (type !== 'MOBILE_BANKING' && type !== 'BANK_ACCOUNT') {
      return apiFailure('invalid_type', 'type must be MOBILE_BANKING or BANK_ACCOUNT', { status: 400 })
    }

    const accountHolderName = String(body.account_holder_name || '').trim()
    if (!accountHolderName) return apiFailure('invalid_input', 'Account holder name is required', { status: 400 })

    const setPrimary = body.is_primary !== false
    const qrImageUrl = validateQrImageUrl(body.qr_image_url as string | undefined)

    let data: Parameters<typeof prisma.employeePaymentMethod.create>[0]['data']

    if (type === 'MOBILE_BANKING') {
      const provider = String(body.provider || '').toUpperCase() as 'BKASH' | 'NAGAD' | 'ROCKET' | 'OTHER'
      if (!['BKASH', 'NAGAD', 'ROCKET', 'OTHER'].includes(provider)) {
        return apiFailure('invalid_provider', 'provider must be BKASH, NAGAD, ROCKET, or OTHER', { status: 400 })
      }
      const usageType = String(body.usage_type || 'PERSONAL').toUpperCase() as 'PERSONAL' | 'BUSINESS'
      data = {
        userId: token.sub,
        businessId,
        type,
        provider,
        usageType: usageType === 'BUSINESS' ? 'BUSINESS' : 'PERSONAL',
        accountHolderName,
        accountNumber: normalizeMobileNumber(String(body.account_number || '')),
        qrImageUrl,
        isPrimary: setPrimary,
      }
    } else {
      const bankName = String(body.bank_name || '').trim()
      if (!bankName) return apiFailure('invalid_input', 'Bank name is required', { status: 400 })
      data = {
        userId: token.sub,
        businessId,
        type,
        accountHolderName,
        accountNumber: normalizeBankAccount(String(body.account_number || '')),
        bankName,
        branchName: String(body.branch_name || '').trim() || null,
        routingNumber: String(body.routing_number || '').trim() || null,
        qrImageUrl,
        isPrimary: setPrimary,
      }
    }

    const existingCount = await prisma.employeePaymentMethod.count({
      where: { userId: token.sub, businessId, isArchived: false },
    })
    if (existingCount === 0) data.isPrimary = true

    if (setPrimary) await clearOtherPrimary(token.sub, businessId)

    const row = await prisma.employeePaymentMethod.create({ data })
    await logPaymentMethodAudit({
      paymentMethodId: row.id,
      userId: token.sub,
      businessId,
      actorUserId: token.sub,
      action: 'CREATED',
      detail: { type: row.type, isPrimary: row.isPrimary },
    })

    return apiSuccess({ method: paymentMethodDto(row, { reveal: true }) })
  } catch (e) {
    return apiFailure('payment_method_create_failed', (e as Error).message, { status: 400 })
  }
}
