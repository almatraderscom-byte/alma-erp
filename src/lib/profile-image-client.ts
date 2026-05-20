const MAX_EDGE = 1400

export type ProfileCaptureResult = {
  imageDataUrl: string
  thumbDataUrl: string
}

export async function captureProfileFromFile(file: File): Promise<ProfileCaptureResult> {
  const dataUrl = await readFileAsDataUrl(file)
  const image = await loadImage(dataUrl)
  const square = cropSquare(image)
  const full = resizeCanvas(square, 512)
  const thumb = resizeCanvas(square, 96)
  return {
    imageDataUrl: full.toDataURL('image/webp', 0.82),
    thumbDataUrl: thumb.toDataURL('image/webp', 0.7),
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Could not read image file'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Invalid image file'))
    img.src = src
  })
}

function cropSquare(img: HTMLImageElement): HTMLCanvasElement {
  const side = Math.min(img.width, img.height)
  const sx = (img.width - side) / 2
  const sy = (img.height - side) / 2
  const scale = Math.min(1, MAX_EDGE / side)
  const out = Math.max(96, Math.round(side * scale))
  const canvas = document.createElement('canvas')
  canvas.width = out
  canvas.height = out
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')
  ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out)
  return canvas
}

function resizeCanvas(source: HTMLCanvasElement, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')
  ctx.drawImage(source, 0, 0, size, size)
  return canvas
}
