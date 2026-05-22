import { NextRequest, NextResponse } from 'next/server'
import type { InvoiceEventType, InvoicePaymentStatus } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { serverGet, serverPost, INVOICE_SERVER_TIMEOUT_MS } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { notifyRole } from '@/lib/notifications'
import { sendFinanceAlert } from '@/lib/resend'
import { errorMeta, logEvent } from '@/lib/logger'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { parseBusinessAccess, businessAllowed } from '@/lib/business-access'
import { moneyDecimal } from '@/lib/payroll-wallet'
import type { Order } from '@/types'
import type { BusinessBranding } from '@/types/branding'
import { resolveBusinessId } from '@/lib/businesses'
import { defaultBusinessBranding } from '@/lib/branding-defaults'
import { orderToPdfModel } from '@/lib/pdf/models'
import { generateInvoicePdfBlob } from '@/lib/pdf/generate'
import { fetchLogoDataUrl } from '@/lib/pdf/branding'
import { shareSlugAlma } from '@/lib/pdf/format'
import { withTimeout } from '@/lib/pdf/timeout'
import { enqueueInvoiceReadySms } from '@/services/sms/events'

/** Allow GAS PDF + Drive to finish (set Vercel Pro / appropriate plan so this is honored). */
export const maxDuration = 120

type InvoiceResult = Record<string, unknown> & {
  ok?: boolean
  invoice_number?: string
  file_url?: string
  drive_url?: string
  share_url?: string
  file_name?: string
  duplicate?: boolean
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    if (url.searchParams.get('next') === '1') {
      const data = await serverGet<{ next?: string; invoice_number?: string }>('next_invoice_num', {}, 0)
      return NextResponse.json(data)
    }

    const ctx = await invoiceContext(req, url.searchParams.get('business_id'))
    if ('error' in ctx) return ctx.error
    const orderId = url.searchParams.get('order_id')?.trim()
    const search = url.searchParams.get('search')?.trim()
    const paymentStatus = url.searchParams.get('payment_status')?.trim().toUpperCase()

    const invoices = await prisma.invoiceRecord.findMany({
      where: {
        deletedAt: null,
        businessId: { in: ctx.businessIds },
        ...(orderId ? { orderId } : {}),
        ...(isPaymentStatus(paymentStatus) ? { paymentStatus } : {}),
        ...(search ? {
          OR: [
            { invoiceNumber: { contains: search, mode: 'insensitive' } },
            { orderId: { contains: search, mode: 'insensitive' } },
            { customerName: { contains: search, mode: 'insensitive' } },
            { customerPhone: { contains: search, mode: 'insensitive' } },
          ],
        } : {}),
      },
      include: {
        events: { orderBy: { createdAt: 'desc' }, take: 8 },
      },
      orderBy: { createdAt: 'desc' },
      take: 250,
    })

    return NextResponse.json({
      ok: true,
      invoices,
      totals: {
        count: invoices.length,
        amount: invoices.reduce((sum, inv) => sum + Number(inv.amount || 0), 0),
        paid: invoices.filter(inv => inv.paymentStatus === 'PAID').length,
        unpaid: invoices.filter(inv => inv.paymentStatus === 'UNPAID').length,
      },
    }, { headers: { 'Cache-Control': 'private, no-store, must-revalidate' } })
  } catch (e) {
    const msg = (e as Error).message
    logEvent('error', 'invoice.get_failed', errorMeta(e))
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let raw: unknown
  const wallStart = Date.now()
  try {
    raw = await req.json()
    const body = raw as Record<string, unknown>
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) {
      logEvent('warn', 'invoice.generate_missing_id')
      return NextResponse.json({ error: 'Missing required field: id', ok: false }, { status: 400 })
    }
    const allowRegenerate = Boolean(body.allow_regenerate)
    const orderRes = await serverGet<{ order?: Order; error?: string }>('order', { id }, 0)
    if (orderRes.error || !orderRes.order) {
      return NextResponse.json({ error: orderRes.error || 'Order not found', ok: false }, { status: 404 })
    }
    const order = orderRes.order
    const businessId = String(order.business_id || body.business_id || 'ALMA_LIFESTYLE')
    const ctx = await invoiceContext(req, businessId)
    if ('error' in ctx) return ctx.error

    const existing = await prisma.invoiceRecord.findFirst({
      where: { businessId, orderId: id, deletedAt: null },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 8 } },
    })
    if (existing && !allowRegenerate) {
      await createInvoiceEvent(existing.id, 'OPENED', ctx, 'Duplicate generation prevented; existing invoice returned.', { orderId: id })
      return NextResponse.json({ ok: true, duplicate: true, invoice: existing, ...invoiceResponseFromRecord(existing) })
    }

    if (!existing && order.invoice_num && !allowRegenerate) {
      const imported = await upsertInvoiceRecord({
        order,
        businessId,
        result: { ok: true, invoice_number: order.invoice_num, duplicate: true },
        ctx,
        eventType: 'CREATED',
        note: 'Imported existing order invoice number into invoice registry.',
      })
      return NextResponse.json({ ok: true, duplicate: true, invoice: imported, ...invoiceResponseFromRecord(imported) })
    }

    const t0 = Date.now()
    const prepared = await prepareInvoicePdf(req, order, businessId, existing?.invoiceNumber, existing?.paymentStatus)
    const result = prepared.result
    const invoice = await upsertInvoiceRecord({
      order,
      businessId,
      result,
      ctx,
      eventType: existing || result.duplicate ? 'REGENERATED' : 'CREATED',
      note: existing || result.duplicate ? 'Invoice regenerated safely.' : 'Invoice generated.',
    })
    if (prepared.pdfBase64 && !result.duplicate) {
      void uploadInvoicePdfToDrive(req, {
        orderId: order.id,
        businessId,
        invoiceNumber: String(result.invoice_number || invoice.invoiceNumber),
        pdfBase64: prepared.pdfBase64,
        invoiceRecordId: invoice.id,
      })
    }
    logEvent('info', 'invoice.generate_completed', {
      orderId: id,
      invoiceNumber: result?.invoice_number,
      invoiceRecordId: invoice.id,
      ok: result?.ok,
      wallMs: Date.now() - t0,
    })
    enqueueInvoiceReadySms({
      businessId,
      phone: order.phone,
      invoice: String(result.invoice_number || invoice.invoiceNumber || id),
      orderId: id,
    })
    await Promise.all([
      notifyRole({
        role: 'SUPER_ADMIN',
        businessId,
        type: 'INVOICE_CREATED',
        priority: 'NORMAL',
        title: 'Invoice created',
        message: `Invoice ${String(result.invoice_number || id)} was generated successfully.`,
        actionUrl: '/invoice',
      }),
      notifyRole({
        role: 'ADMIN',
        businessId,
        type: 'INVOICE_CREATED',
        priority: 'NORMAL',
        title: 'Invoice created',
        message: `Invoice ${String(result.invoice_number || id)} was generated successfully.`,
        actionUrl: '/invoice',
      }),
      sendFinanceAlert({
        businessId,
        subject: `Invoice generated · ${String(result.invoice_number || id)}`,
        title: 'Invoice generated',
        preview: `Invoice ${String(result.invoice_number || id)} was generated successfully.`,
        text: `Invoice ${String(result.invoice_number || id)} was generated successfully for order ${id}.`,
        priority: 'NORMAL',
        actionUrl: '/invoice',
        actionLabel: 'Open invoices',
        dedupeKey: `invoice-generated:${String(result.invoice_number || id)}`,
        metadata: { orderId: id, invoiceNumber: result.invoice_number, invoiceRecordId: invoice.id },
      }),
    ])
    return NextResponse.json({ ...result, invoice })
  } catch (e) {
    const msg = (e as Error).message
    const orderId = typeof raw === 'object' && raw && typeof (raw as Record<string, unknown>).id === 'string'
      ? (raw as Record<string, unknown>).id
      : undefined
    logEvent('error', 'invoice.generate_failed', { ...errorMeta(e), wallMs: Date.now() - wallStart, orderId })
    return NextResponse.json({ error: msg, ok: false }, { status: 502 })
  }
}

async function prepareInvoicePdf(
  req: NextRequest,
  order: Order,
  businessId: string,
  existingInvoiceNumber?: string | null,
  paymentStatus?: InvoicePaymentStatus | null,
): Promise<{ result: InvoiceResult; pdfBase64?: string }> {
  const invoiceNumber = existingInvoiceNumber || order.invoice_num || await peekInvoiceNumber()
  const branding = await resolveInvoiceBranding(businessId)
  const logoDataUrl = await resolveInvoiceLogoDataUrl(branding, order.id)
  const pdfModel = orderToPdfModel(order, branding, logoDataUrl, invoiceNumber, { paymentStatus: paymentStatus || undefined })
  const generated = await generateInvoicePdfBlob(pdfModel)
  if (!generated.ok) {
    throw new Error(generated.error)
  }
  const pdfBase64 = Buffer.from(await generated.blob.arrayBuffer()).toString('base64')
  const internalShareUrl = buildInternalInvoiceShareUrl(req, order.id)
  logEvent('info', 'invoice.react_pdf_rendered', {
    orderId: order.id,
    invoiceNumber,
    pdfBytes: generated.blob.size,
    renderMs: generated.durationMs,
    logoLoaded: Boolean(logoDataUrl),
  })
  return {
    pdfBase64,
    result: {
      ok: true,
      invoice_number: invoiceNumber,
      file_url: internalShareUrl,
      drive_url: internalShareUrl,
      share_url: internalShareUrl,
      file_name: `Invoice-${order.id}.pdf`,
      duplicate: false,
      drive_sync: 'pending',
      renderer: 'react-pdf',
    },
  }
}

async function uploadInvoicePdfToDrive(
  req: NextRequest,
  input: {
    orderId: string
    businessId: string
    invoiceNumber: string
    pdfBase64: string
    invoiceRecordId: string
  },
) {
  const started = Date.now()
  try {
    const driveResult = await serverPost<InvoiceResult>('save_invoice_pdf', await mergeActorPayload(req, {
      id: input.orderId,
      business_id: input.businessId,
      invoice_number: input.invoiceNumber,
      pdf_base64: input.pdfBase64,
      allow_regenerate: true,
      renderer: 'react-pdf',
    }), {
      timeoutMs: INVOICE_SERVER_TIMEOUT_MS,
    })
    const url = String(driveResult.drive_url || driveResult.file_url || driveResult.share_url || '').trim()
    if (url) {
      await prisma.invoiceRecord.update({
        where: { id: input.invoiceRecordId },
        data: {
          driveUrl: String(driveResult.drive_url || url),
          fileUrl: String(driveResult.file_url || url),
          shareUrl: String(driveResult.share_url || url),
          fileName: String(driveResult.file_name || ''),
        },
      })
    }
    logEvent('info', 'invoice.react_pdf_saved', {
      orderId: input.orderId,
      invoiceNumber: driveResult.invoice_number || input.invoiceNumber,
      wallMs: Date.now() - started,
      driveUrl: url || undefined,
    })
  } catch (e) {
    logEvent('warn', 'invoice.drive_upload_failed', {
      orderId: input.orderId,
      invoiceRecordId: input.invoiceRecordId,
      ...errorMeta(e),
      wallMs: Date.now() - started,
    })
  }
}

function buildInternalInvoiceShareUrl(req: NextRequest, orderId: string) {
  const origin = resolveAppOrigin(req)
  const path = `/invoice/share/${shareSlugAlma(orderId)}`
  return origin ? `${origin}${path}` : path
}

function resolveAppOrigin(req: NextRequest) {
  const forwardedHost = req.headers.get('x-forwarded-host')
  const host = forwardedHost || req.headers.get('host')
  if (!host) {
    return (
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
    ).replace(/\/$/, '')
  }
  const proto = req.headers.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https')
  return `${proto}://${host}`.replace(/\/$/, '')
}

async function peekInvoiceNumber() {
  const next = await serverGet<{ next?: string; invoice_number?: string }>('next_invoice_num', {}, 0)
  return String(next.next || next.invoice_number || '').trim()
}

async function resolveInvoiceBranding(businessId: string): Promise<BusinessBranding> {
  const resolvedBusinessId = resolveBusinessId(businessId)
  try {
    const data = await serverGet<{ branding?: BusinessBranding }>('branding', { business_id: resolvedBusinessId }, 0)
    if (data.branding?.business_id) return data.branding
  } catch (e) {
    logEvent('warn', 'invoice.branding_fallback_for_pdf', { ...errorMeta(e), businessId: resolvedBusinessId })
  }
  return defaultBusinessBranding(resolvedBusinessId)
}

async function resolveInvoiceLogoDataUrl(branding: BusinessBranding, orderId: string) {
  if (!branding.logo_url?.startsWith('http')) return undefined
  try {
    return await withTimeout(fetchLogoDataUrl(branding.logo_url), 8000, 'invoice logo preload')
  } catch (e) {
    logEvent('warn', 'invoice.logo_fallback_for_pdf', { ...errorMeta(e), orderId, logoUrlHost: safeHost(branding.logo_url) })
    return undefined
  }
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return 'invalid-url'
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as { id?: string; payment_status?: string }
    if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    if (!isPaymentStatus(body.payment_status)) return NextResponse.json({ error: 'valid payment_status required' }, { status: 400 })

    const existing = await prisma.invoiceRecord.findUnique({ where: { id: body.id } })
    if (!existing || existing.deletedAt) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    const ctx = await invoiceContext(req, existing.businessId)
    if ('error' in ctx) return ctx.error

    const invoice = await prisma.invoiceRecord.update({
      where: { id: existing.id },
      data: { paymentStatus: body.payment_status },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 8 } },
    })
    await createInvoiceEvent(invoice.id, 'REGENERATED', ctx, `Payment status changed to ${body.payment_status}.`, {
      previousPaymentStatus: existing.paymentStatus,
      paymentStatus: body.payment_status,
    })
    return NextResponse.json({ ok: true, invoice })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get('id')?.trim()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    const existing = await prisma.invoiceRecord.findUnique({ where: { id } })
    if (!existing || existing.deletedAt) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    const ctx = await invoiceContext(req, existing.businessId)
    if ('error' in ctx) return ctx.error
    if (!['SUPER_ADMIN', 'ADMIN'].includes(ctx.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const invoice = await prisma.invoiceRecord.update({
      where: { id },
      data: { deletedAt: new Date() },
    })
    await createInvoiceEvent(id, 'DELETED', ctx, 'Invoice registry record deleted.', { orderId: invoice.orderId })
    logEvent('warn', 'invoice.deleted', { invoiceId: id, orderId: invoice.orderId, actorUserId: ctx.userId })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

async function invoiceContext(req: NextRequest, requestedBusinessId?: string | null) {
  const token = await getJwt(req)
  if (!token?.sub) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const businessIds = requestedBusinessId
    ? businessAllowed(token.businessAccess as string, requestedBusinessId) ? [requestedBusinessId] : []
    : parseBusinessAccess(token.businessAccess as string)
  if (!businessIds.length) return { error: NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 }) }
  return {
    token,
    userId: String(token.sub),
    actorName: String(token.name || token.email || 'User'),
    role: String(token.role || 'VIEWER'),
    businessIds,
  }
}

async function upsertInvoiceRecord({
  order,
  businessId,
  result,
  ctx,
  eventType,
  note,
}: {
  order: Order
  businessId: string
  result: InvoiceResult
  ctx: Exclude<Awaited<ReturnType<typeof invoiceContext>>, { error: NextResponse }>
  eventType: InvoiceEventType
  note: string
}) {
  const invoiceNumber = String(result.invoice_number || order.invoice_num || `INV-${order.id}`).trim()
  const url = String(result.drive_url || result.file_url || result.share_url || '').trim()
  const data = {
    invoiceNumber,
    orderId: order.id,
    customerName: order.customer || '',
    customerPhone: order.phone || null,
    businessId,
    amount: moneyDecimal(order.sell_price || 0),
    driveUrl: String(result.drive_url || url || ''),
    fileUrl: String(result.file_url || url || ''),
    shareUrl: String(result.share_url || url || ''),
    fileName: String(result.file_name || ''),
    generatedById: ctx.userId,
    generatedByName: ctx.actorName,
    deletedAt: null,
  }
  const invoice = await prisma.invoiceRecord.upsert({
    where: { businessId_orderId: { businessId, orderId: order.id } },
    update: data,
    create: data,
    include: { events: { orderBy: { createdAt: 'desc' }, take: 8 } },
  })
  await createInvoiceEvent(invoice.id, eventType, ctx, note, {
    orderId: order.id,
    invoiceNumber,
    duplicate: Boolean(result.duplicate),
    driveUrl: result.drive_url,
  })
  return prisma.invoiceRecord.findUniqueOrThrow({
    where: { id: invoice.id },
    include: { events: { orderBy: { createdAt: 'desc' }, take: 8 } },
  })
}

async function createInvoiceEvent(
  invoiceId: string,
  type: InvoiceEventType,
  ctx: Exclude<Awaited<ReturnType<typeof invoiceContext>>, { error: NextResponse }>,
  note: string,
  metadata?: Record<string, unknown>,
) {
  return prisma.invoiceEvent.create({
    data: {
      invoiceId,
      type,
      actorId: ctx.userId,
      actorName: ctx.actorName,
      note,
      metadataJson: metadata ? JSON.stringify(metadata).slice(0, 12000) : null,
    },
  })
}

function invoiceResponseFromRecord(invoice: {
  invoiceNumber: string
  driveUrl?: string | null
  fileUrl?: string | null
  shareUrl?: string | null
  fileName?: string | null
}) {
  const url = invoice.driveUrl || invoice.fileUrl || invoice.shareUrl || ''
  return {
    invoice_number: invoice.invoiceNumber,
    drive_url: url,
    file_url: invoice.fileUrl || url,
    share_url: invoice.shareUrl || url,
    file_name: invoice.fileName || '',
  }
}

function isPaymentStatus(value: unknown): value is InvoicePaymentStatus {
  return ['UNPAID', 'PARTIAL', 'PAID', 'VOID'].includes(String(value || '').toUpperCase())
}
