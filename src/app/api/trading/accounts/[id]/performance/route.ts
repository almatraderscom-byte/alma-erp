import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { uploadTradingScreenshotToDrive } from '@/lib/trading-drive'
import { TRADING_BUSINESS_ID, canAccessTradingAccount, getTradingContext, isResponse, parseTradingDate, requireTradingWrite } from '@/lib/trading'
import { normalizeTradingScreenshotUpload } from '@/lib/trading-image-server'
import { tradingBdDayBounds } from '@/lib/trading-compliance'
import {
  queueTradingScreenshotFailureAlert,
  queueTradingScreenshotUploadAlert,
} from '@/lib/telegram-notification/trading-ops-alerts'

export const runtime = 'nodejs'
export const maxDuration = 60

type RouteContext = { params: { id: string } }

const UPLOAD_COOLDOWN_MS = 45_000

export async function GET(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  try {
    const account = await prisma.tradingAccount.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true, assignedUserId: true },
    })
    if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })
    if (!canAccessTradingAccount(ctx, account)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const url = new URL(req.url)
    const archived = url.searchParams.get('archived') === '1'
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || (archived ? 30 : 7)), 1), 60)
    const cursor = url.searchParams.get('cursor') || undefined
    const visibleCutoff = recentVisibleCutoff()
    const rows = await prisma.tradingPerformanceScreenshot.findMany({
      where: {
        tradingAccountId: params.id,
        businessId: TRADING_BUSINESS_ID,
        deletedAt: null,
        ...(archived ? { OR: [{ archivedAt: { not: null } }, { shotDate: { lt: visibleCutoff } }] } : { archivedAt: null, shotDate: { gte: visibleCutoff } }),
      },
      include: { uploader: { select: { name: true } } },
      orderBy: [{ shotDate: 'desc' }, { createdAt: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, limit)
    const screenshots = page.map(shot => ({
      ...shot,
      signedUrl: `/api/trading/screenshots/${encodeURIComponent(shot.id)}/preview`,
    }))

    return NextResponse.json({
      screenshots,
      nextCursor: rows.length > limit ? rows[limit].id : null,
      archived,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied

  try {
    const account = await prisma.tradingAccount.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true, assignedUserId: true, accountTitle: true, assignedUser: { select: { employeeIdGas: true } } },
    })
    if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })
    if (!canAccessTradingAccount(ctx, account)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'screenshot file required' }, { status: 400 })

    const shotDate = parseTradingDate(form.get('shotDate'), 'shotDate')
    if (isResponse(shotDate)) return shotDate
    shotDate.setHours(0, 0, 0, 0)
    const note = String(form.get('note') || '').trim() || null
    const clientFingerprint = String(form.get('fingerprint') || '').trim() || null
    const safeName = sanitizeFileName(file.name || 'performance-screenshot')

    const normalized = await normalizeTradingScreenshotUpload(file, safeName)
    const { start: dayStart, end: dayEnd } = tradingBdDayBounds()

    const recentBurst = await prisma.tradingPerformanceScreenshot.findFirst({
      where: {
        tradingAccountId: params.id,
        businessId: TRADING_BUSINESS_ID,
        deletedAt: null,
        uploadedBy: ctx.userId,
        createdAt: { gte: new Date(Date.now() - UPLOAD_COOLDOWN_MS) },
      },
      select: { id: true },
    })
    if (recentBurst) {
      return NextResponse.json({ error: 'Please wait before uploading again.', code: 'UPLOAD_COOLDOWN' }, { status: 429 })
    }

    const duplicateHash = await prisma.tradingPerformanceScreenshot.findFirst({
      where: {
        tradingAccountId: params.id,
        businessId: TRADING_BUSINESS_ID,
        deletedAt: null,
        contentHash: normalized.contentHash,
        shotDate: { gte: dayStart, lt: dayEnd },
      },
      select: { id: true },
    })
    if (duplicateHash) {
      return NextResponse.json({ error: 'This screenshot was already uploaded today.', code: 'DUPLICATE_IMAGE' }, { status: 409 })
    }

    if (clientFingerprint) {
      const dupClient = await prisma.tradingPerformanceScreenshot.findFirst({
        where: {
          tradingAccountId: params.id,
          businessId: TRADING_BUSINESS_ID,
          deletedAt: null,
          note: { contains: `fp:${clientFingerprint}` },
          shotDate: { gte: dayStart, lt: dayEnd },
        },
        select: { id: true },
      })
      if (dupClient) {
        return NextResponse.json({ error: 'Duplicate upload detected.', code: 'DUPLICATE_CLIENT' }, { status: 409 })
      }
    }

    const upload = await uploadTradingScreenshotToDrive({
      accountId: params.id,
      accountName: account.accountTitle,
      employeeId: account.assignedUser?.employeeIdGas || ctx.userId,
      uploadDate: shotDate.toISOString().slice(0, 10),
      fileName: `${crypto.randomUUID()}-${safeName.replace(/\.[a-z0-9]{2,6}$/i, '')}${normalized.extension}`,
      mimeType: normalized.mimeType,
      base64: normalized.buffer.toString('base64'),
    })
    if (!upload.drive_file_id) return NextResponse.json({ error: 'Google Drive upload did not return a file id' }, { status: 502 })

    const expiryDate = new Date(shotDate)
    expiryDate.setDate(expiryDate.getDate() + 30)
    const storedNote = [note, clientFingerprint ? `fp:${clientFingerprint}` : null].filter(Boolean).join(' · ') || null

    const screenshot = await prisma.$transaction(async tx => {
      const created = await tx.tradingPerformanceScreenshot.create({
        data: {
          tradingAccountId: params.id,
          businessId: TRADING_BUSINESS_ID,
          shotDate,
          employeeId: account.assignedUser?.employeeIdGas || ctx.userId,
          driveFileId: upload.drive_file_id,
          driveFolderId: upload.drive_folder_id || null,
          previewUrl: `/api/trading/screenshots/__ID__/preview`,
          originalName: safeName,
          contentType: normalized.mimeType,
          sizeBytes: normalized.normalizedSize,
          contentHash: normalized.contentHash,
          note: storedNote,
          expiryDate,
          archivedAt: shotDate < recentVisibleCutoff() ? new Date() : null,
          uploadedBy: ctx.userId,
        },
        include: { uploader: { select: { name: true } } },
      })
      await tx.tradingPerformanceScreenshot.update({
        where: { id: created.id },
        data: { previewUrl: `/api/trading/screenshots/${created.id}/preview` },
      })
      await archiveOldScreenshots(tx, params.id)
      return tx.tradingPerformanceScreenshot.findUniqueOrThrow({
        where: { id: created.id },
        include: { uploader: { select: { name: true } } },
      })
    })

    const uploader = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { name: true },
    })
    try {
      await queueTradingScreenshotUploadAlert({
        businessId: TRADING_BUSINESS_ID,
        screenshotId: screenshot.id,
        accountId: account.id,
        accountTitle: account.accountTitle,
        uploaderUserId: ctx.userId,
        uploaderName: uploader?.name || screenshot.uploader?.name || 'Staff',
        shotDate: shotDate.toISOString().slice(0, 10),
      })
    } catch (err) {
      console.error('[trading-upload] telegram notify', (err as Error).message)
    }

    return NextResponse.json({
      ok: true,
      screenshot: {
        ...screenshot,
        signedUrl: `/api/trading/screenshots/${encodeURIComponent(screenshot.id)}/preview`,
      },
    }, { status: 201 })
  } catch (e) {
    const err = e as Error
    console.error('[trading-upload]', {
      route: 'POST performance',
      accountId: params.id,
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 4),
    })
    const status = err.message.includes('between 1 byte') || err.message.includes('Unsupported') || err.message.includes('too large')
      ? 400
      : 500
    const account = await prisma.tradingAccount.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID },
      select: { accountTitle: true },
    }).catch(() => null)
    const uploader = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { name: true },
    }).catch(() => null)
    await queueTradingScreenshotFailureAlert({
      businessId: TRADING_BUSINESS_ID,
      accountId: params.id,
      accountTitle: account?.accountTitle || params.id,
      uploaderUserId: ctx.userId,
      uploaderName: uploader?.name || 'Staff',
      error: err.message,
    })
    return NextResponse.json({ error: err.message, code: 'UPLOAD_FAILED' }, { status })
  }
}

async function archiveOldScreenshots(tx: Prisma.TransactionClient, tradingAccountId: string) {
  const visibleCutoff = recentVisibleCutoff()
  await tx.tradingPerformanceScreenshot.updateMany({
    where: { tradingAccountId, businessId: TRADING_BUSINESS_ID, deletedAt: null, shotDate: { lt: visibleCutoff }, archivedAt: null },
    data: { archivedAt: new Date() },
  })
  await tx.tradingPerformanceScreenshot.updateMany({
    where: { tradingAccountId, businessId: TRADING_BUSINESS_ID, deletedAt: null, shotDate: { gte: visibleCutoff }, archivedAt: { not: null } },
    data: { archivedAt: null },
  })
}

function recentVisibleCutoff() {
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - 6)
  return cutoff
}

function sanitizeFileName(name: string) {
  return name.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(0, 120) || 'performance-screenshot'
}
