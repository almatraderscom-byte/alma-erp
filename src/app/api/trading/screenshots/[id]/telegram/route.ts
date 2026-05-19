import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchTradingScreenshotFromDrive } from '@/lib/trading-drive'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import { verifyScreenshotTelegramToken } from '@/lib/telegram-notification/screenshot-preview'

export const runtime = 'nodejs'
export const maxDuration = 60

type RouteContext = { params: { id: string } }

/** Token-authenticated preview for Telegram sendPhoto (no ERP session). */
export async function GET(req: NextRequest, { params }: RouteContext) {
  const url = new URL(req.url)
  const exp = Number(url.searchParams.get('exp'))
  const sig = url.searchParams.get('sig') || ''
  if (!verifyScreenshotTelegramToken(params.id, exp, sig)) {
    return NextResponse.json({ error: 'Invalid or expired preview token' }, { status: 403 })
  }

  const screenshot = await prisma.tradingPerformanceScreenshot.findFirst({
    where: { id: params.id, businessId: TRADING_BUSINESS_ID, deletedAt: null, expiryDate: { gt: new Date() } },
    select: { driveFileId: true, contentType: true, originalName: true },
  })
  if (!screenshot) return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 })

  try {
    const file = await fetchTradingScreenshotFromDrive(screenshot.driveFileId)
    const bytes = Buffer.from(file.base64, 'base64')
    return new NextResponse(bytes, {
      headers: {
        'Content-Type': file.mime_type || screenshot.contentType,
        'Content-Disposition': `inline; filename="${sanitize(file.file_name || screenshot.originalName)}"`,
        'Cache-Control': 'public, max-age=300',
      },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 })
  }
}

function sanitize(name: string) {
  return name.replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'screenshot.webp'
}
