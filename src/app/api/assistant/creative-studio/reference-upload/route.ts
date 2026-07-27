import { randomUUID } from 'crypto'
import { type NextRequest } from 'next/server'
import { agentStorageDelete, agentStorageUpload } from '@/agent/lib/storage'
import {
  assertStudioCapability,
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  requireStudioResourceContext,
  writeStudioResourceScope,
} from '@/lib/creative-studio/studio-resource-scope'

export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_BYTES = 10 * 1024 * 1024
const CONTENT_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])

export async function POST(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return Response.json({ error: 'invalid_form_data' }, { status: 400 })
  }

  const file = formData.get('file')
  const kind = formData.get('kind')?.toString()
  const brandProfileId = formData.get('brandProfileId')?.toString()
  const projectId = formData.get('projectId')?.toString()
  if (!(file instanceof File)) {
    return Response.json({ error: 'reference_file_required' }, { status: 400 })
  }
  if (kind !== 'product' && kind !== 'model') {
    return Response.json({ error: 'reference_kind_invalid' }, { status: 422 })
  }
  const extension = CONTENT_TYPES.get(file.type.toLowerCase())
  if (!extension) {
    return Response.json({
      error: 'reference_type_unsupported',
      message: 'Use JPEG, PNG or WebP.',
    }, { status: 415 })
  }
  if (file.size < 1 || file.size > MAX_BYTES) {
    return Response.json({ error: 'reference_size_invalid', maxMb: 10 }, { status: 413 })
  }

  try {
    const context = await requireStudioResourceContext(actor, {
      brandProfileId,
      projectId,
    })
    assertStudioCapability(context.access.role, 'draft')

    const bytes = Buffer.from(await file.arrayBuffer())
    const sharp = (await import('sharp')).default
    const metadata = await sharp(bytes).metadata()
    if (!metadata.width || !metadata.height) {
      return Response.json({ error: 'reference_image_invalid' }, { status: 422 })
    }

    const referenceId = randomUUID()
    const path = `creative-studio/references/${context.projectId}/${referenceId}.${extension}`
    await agentStorageUpload(path, bytes, file.type, { upsert: false })
    try {
      await writeStudioResourceScope('reference', referenceId, {
        ownerId: context.access.ownerId,
        brandProfileId: context.brandProfileId,
        projectId: context.projectId,
        createdById: actor.userId,
        sourcePath: path,
        referenceKind: kind,
      })
    } catch (error) {
      await agentStorageDelete([path]).catch(() => undefined)
      throw error
    }

    return Response.json({
      id: referenceId,
      path,
      kind,
      name: file.name.slice(0, 180),
      sizeBytes: file.size,
      width: metadata.width,
      height: metadata.height,
    })
  } catch (error) {
    return studioAccessErrorResponse(error, 'creative-reference-upload')
  }
}
