/**
 * Client-side face capture compression (front camera, mobile-friendly).
 */

import { MAX_FACE_IMAGE_BYTES } from '@/lib/attendance-face-constants'

export type FaceCaptureResult = {
  imageDataUrl: string
  thumbDataUrl: string
  contentType: string
}

export async function captureFaceFromFile(file: File): Promise<FaceCaptureResult> {
  let imageDataUrl = await renderFaceCanvas(file, 512, 0.52)
  let attempts = 0
  while (dataUrlByteSize(imageDataUrl) > MAX_FACE_IMAGE_BYTES && attempts < 4) {
    const scale = 480 - attempts * 64
    const quality = 0.48 - attempts * 0.06
    imageDataUrl = await renderFaceCanvas(file, Math.max(320, scale), Math.max(0.32, quality))
    attempts += 1
  }
  if (dataUrlByteSize(imageDataUrl) > MAX_FACE_IMAGE_BYTES) {
    throw new Error('Photo is too large after compression. Move closer to the camera or use better lighting and retake.')
  }
  const thumbDataUrl = await renderFaceCanvas(file, 160, 0.42)
  return { imageDataUrl, thumbDataUrl, contentType: 'image/jpeg' }
}

function dataUrlByteSize(dataUrl: string) {
  const base64 = dataUrl.split(',')[1] || ''
  return Math.ceil((base64.length * 3) / 4)
}

function renderFaceCanvas(file: File, maxEdge: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      const ctx = canvas.getContext('2d')
      URL.revokeObjectURL(url)
      if (!ctx) {
        reject(new Error('Could not process camera image on this device'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read camera image. If you used HEIC, retake or pick a JPEG/PNG photo.'))
    }
    img.src = url
  })
}

export function mapCheckInError(message: string, resStatus?: number) {
  const m = message.toLowerCase()
  if (resStatus === 401) return 'Session expired — refresh the page and sign in again.'
  if (resStatus === 403) return message
  if (resStatus === 503) return message
  if (m.includes('employee id') || m.includes('hr employee')) {
    return 'Your account is not linked to an HR employee ID. Ask admin to link it in Users settings.'
  }
  if (m.includes('face') && m.includes('required')) return 'Take a front-camera selfie before starting work.'
  if (m.includes('process face') || m.includes('invalid face') || m.includes('too large')) {
    return 'Could not use this photo. Retake with the front camera in good light.'
  }
  if (m.includes('already') || m.includes('duplicate')) return 'You already checked in today.'
  if (m.includes('network') || m.includes('failed to fetch') || m.includes('timeout')) {
    return 'Network error — check connection and retry.'
  }
  return message || 'Check-in failed. Please retry.'
}
