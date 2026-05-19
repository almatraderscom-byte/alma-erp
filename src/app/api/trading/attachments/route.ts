import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { uploadStorageObject } from '@/lib/supabase-storage'
import { TRADING_BUSINESS_ID, getTradingContext, requireTradingWrite } from '@/lib/trading'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_BYTES = 3 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'])

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied

  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 })
    if (!ALLOWED_TYPES.has(file.type)) return NextResponse.json({ error: 'Unsupported attachment file type.' }, { status: 400 })
    if (file.size <= 0 || file.size > MAX_BYTES) return NextResponse.json({ error: 'Attachment file must be 1 byte to 3 MB.' }, { status: 400 })

    const safeName = sanitizeFileName(file.name || 'trading-attachment')
    const objectPath = [
      TRADING_BUSINESS_ID,
      'trading',
      new Date().toISOString().slice(0, 10),
      `${crypto.randomUUID()}${extensionFor(file.type, safeName)}`,
    ].join('/')
    const uploaded = await uploadStorageObject(objectPath, file, file.type)
    const attachment = await prisma.expenseAttachment.create({
      data: {
        businessId: TRADING_BUSINESS_ID,
        bucket: uploaded.bucket,
        objectPath: uploaded.objectPath,
        originalName: safeName,
        contentType: file.type,
        sizeBytes: file.size,
        uploadedById: ctx.userId,
      },
    })

    return NextResponse.json({
      ok: true,
      attachment: {
        id: attachment.id,
        url: `/api/finance/receipts/${attachment.id}`,
        fileName: attachment.originalName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
      },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

function sanitizeFileName(name: string) {
  return name.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(0, 120) || 'trading-attachment'
}

function extensionFor(type: string, safeName: string) {
  const fromName = safeName.match(/\.[a-z0-9]{2,6}$/i)?.[0]?.toLowerCase()
  if (fromName) return fromName
  if (type === 'application/pdf') return '.pdf'
  if (type === 'image/png') return '.png'
  if (type === 'image/webp') return '.webp'
  if (type === 'image/gif') return '.gif'
  return '.jpg'
}
