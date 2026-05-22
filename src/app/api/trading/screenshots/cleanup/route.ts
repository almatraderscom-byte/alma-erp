import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { deleteTradingScreenshotsFromDrive } from '@/lib/trading-drive'
import { TRADING_BUSINESS_ID } from '@/lib/trading'

export const runtime = 'nodejs'
export const maxDuration = 60

function cronAuthorized(req: NextRequest) {
  const expectedSecret = process.env.TRADING_SCREENSHOT_CLEANUP_SECRET || process.env.CRON_SECRET
  if (!expectedSecret) return false
  return req.headers.get('authorization') === `Bearer ${expectedSecret}`
}

async function cleanup(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const expired = await prisma.tradingPerformanceScreenshot.findMany({
    where: { businessId: TRADING_BUSINESS_ID, expiryDate: { lte: now }, deletedAt: null },
    select: { id: true, driveFileId: true },
    take: 200,
    orderBy: { expiryDate: 'asc' },
  })
  const driveFileIds = expired.map(row => row.driveFileId).filter(Boolean)
  const drive = await deleteTradingScreenshotsFromDrive(driveFileIds)
  await prisma.tradingPerformanceScreenshot.deleteMany({
    where: { id: { in: expired.map(row => row.id) } },
  })

  return NextResponse.json({
    ok: true,
    expiredMetadataRows: expired.length,
    driveDeleted: drive.deleted,
    driveMissing: drive.missing,
    driveErrors: drive.errors || [],
  })
}

export async function GET(req: NextRequest) {
  return cleanup(req)
}

export async function POST(req: NextRequest) {
  return cleanup(req)
}
