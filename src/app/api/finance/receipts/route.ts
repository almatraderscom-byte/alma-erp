import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { businessAllowed } from '@/lib/business-access'
import { uploadStorageObject } from '@/lib/supabase-storage'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
])

export async function POST(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const form = await req.formData()
    const file = form.get('file')
    const businessId = String(form.get('business_id') || 'ALMA_LIFESTYLE')
    if (!businessAllowed(token.businessAccess as string, businessId)) {
      return NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 })
    }
    if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 })
    if (!ALLOWED_TYPES.has(file.type)) return NextResponse.json({ error: 'Unsupported receipt file type.' }, { status: 400 })
    if (file.size <= 0 || file.size > MAX_BYTES) return NextResponse.json({ error: 'Receipt file must be 1 byte to 10 MB.' }, { status: 400 })

    const safeName = sanitizeFileName(file.name || 'receipt')
    const ext = extensionFor(file.type, safeName)
    const objectPath = [
      businessId,
      new Date().toISOString().slice(0, 10),
      `${crypto.randomUUID()}${ext}`,
    ].join('/')

    const uploaded = await uploadStorageObject(objectPath, file, file.type)
    const attachment = await prisma.expenseAttachment.create({
      data: {
        businessId,
        bucket: uploaded.bucket,
        objectPath: uploaded.objectPath,
        originalName: safeName,
        contentType: file.type,
        sizeBytes: file.size,
        uploadedById: String(token.sub),
        uploadedByName: String(token.name || token.email || 'User'),
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
        uploadedAt: attachment.uploadedAt,
        uploadedByName: attachment.uploadedByName,
      },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

function sanitizeFileName(name: string) {
  return name.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(0, 120) || 'receipt'
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
