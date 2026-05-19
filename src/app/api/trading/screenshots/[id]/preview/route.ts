import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchTradingScreenshotFromDrive } from '@/lib/trading-drive'
import { TRADING_BUSINESS_ID, canAccessTradingAccount, getTradingContext } from '@/lib/trading'

export const runtime = 'nodejs'
export const maxDuration = 60

type RouteContext = { params: { id: string } }

export async function GET(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  const screenshot = await prisma.tradingPerformanceScreenshot.findFirst({
    where: { id: params.id, businessId: TRADING_BUSINESS_ID, deletedAt: null, expiryDate: { gt: new Date() } },
    include: { tradingAccount: { select: { assignedUserId: true } } },
  })
  if (!screenshot) return NextResponse.json({ error: 'Screenshot not found or expired' }, { status: 404 })
  if (!canAccessTradingAccount(ctx, screenshot.tradingAccount)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const file = await fetchTradingScreenshotFromDrive(screenshot.driveFileId)
    const bytes = Buffer.from(file.base64, 'base64')
    return new NextResponse(bytes, {
      headers: {
        'Content-Type': file.mime_type || screenshot.contentType,
        'Content-Disposition': `inline; filename="${sanitizeHeaderFileName(file.file_name || screenshot.originalName)}"`,
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 })
  }
}

function sanitizeHeaderFileName(name: string) {
  return name.replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'screenshot.webp'
}
