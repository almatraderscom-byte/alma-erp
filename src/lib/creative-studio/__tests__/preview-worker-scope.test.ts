import { afterEach, describe, expect, it } from 'vitest'
import {
  creativeStudioImageQueueStatus,
  isAuthorizedPreviewWorkerRequest,
  isPreviewApprovedCreativeStudioImageAction,
} from '@/lib/creative-studio/preview-worker-scope'

const priorVercelEnv = process.env.VERCEL_ENV

afterEach(() => {
  if (priorVercelEnv === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = priorVercelEnv
})

const signedPayload = {
  creativeStudio: true,
  studioSurface: 'v3',
  studioRunAuthorization: { receipt: 'signed-receipt' },
}

describe('Creative Studio preview worker isolation', () => {
  it('uses the isolated lane only for signed Creative Studio image work in Vercel previews', () => {
    process.env.VERCEL_ENV = 'preview'
    expect(creativeStudioImageQueueStatus(signedPayload)).toBe('preview_approved')
    expect(creativeStudioImageQueueStatus({ creativeStudio: true, studioSurface: 'v3' })).toBe('approved')
    expect(creativeStudioImageQueueStatus({ studioRunAuthorization: { receipt: 'x' } })).toBe('approved')
  })

  it('keeps signed chain-internal image artifacts in the same isolated preview lane', () => {
    process.env.VERCEL_ENV = 'preview'
    expect(creativeStudioImageQueueStatus({
      ...signedPayload,
      creativeStudio: false,
      chainInternal: true,
    })).toBe('preview_approved')
  })

  it('keeps production on the existing approved lane', () => {
    process.env.VERCEL_ENV = 'production'
    expect(creativeStudioImageQueueStatus(signedPayload)).toBe('approved')
  })

  it('requires both preview runtime and the exact worker scope header', () => {
    process.env.VERCEL_ENV = 'preview'
    const scoped = new Request('https://preview.example.test', {
      headers: { 'x-alma-worker-scope': 'creative-studio-preview' },
    })
    expect(isAuthorizedPreviewWorkerRequest(scoped)).toBe(true)
    expect(isAuthorizedPreviewWorkerRequest(new Request('https://preview.example.test'))).toBe(false)
    process.env.VERCEL_ENV = 'production'
    expect(isAuthorizedPreviewWorkerRequest(scoped)).toBe(false)
  })

  it('authorizes only a signed image action already placed in the preview lane', () => {
    process.env.VERCEL_ENV = 'preview'
    expect(isPreviewApprovedCreativeStudioImageAction({
      status: 'preview_approved',
      type: 'image_gen',
      payload: signedPayload,
    })).toBe(true)
    expect(isPreviewApprovedCreativeStudioImageAction({
      status: 'approved',
      type: 'image_gen',
      payload: signedPayload,
    })).toBe(false)
  })
})
