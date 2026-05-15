import { Font } from '@react-pdf/renderer'
import { FONT_STACK_PDF } from '@/lib/currency'
import { pdfSafeMode, PDF_FONT_TIMEOUT_MS } from '@/lib/pdf/config'
import { pdfDebug, pdfDebugError } from '@/lib/pdf/debug'
import { withTimeout } from '@/lib/pdf/timeout'

let registered = false
let registerPromise: Promise<void> | null = null
let activeFontFamily = 'Helvetica'

export function getPdfFontFamily(): string {
  return activeFontFamily
}

function useBuiltInHelvetica(): void {
  activeFontFamily = 'Helvetica'
  try {
    Font.registerHyphenationCallback(word => [word])
  } catch {
    /* already registered */
  }
  pdfDebug('fonts: built-in Helvetica (no remote fetch)')
}

async function registerNotoIfAvailable(): Promise<void> {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const regular = `${origin}/fonts/NotoSansBengali-Regular.ttf`

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      Font.register({
        family: FONT_STACK_PDF,
        fonts: [
          { src: regular, fontWeight: 400 },
          { src: `${origin}/fonts/NotoSansBengali-SemiBold.ttf`, fontWeight: 600 },
          { src: `${origin}/fonts/NotoSansBengali-Bold.ttf`, fontWeight: 700 },
        ],
      })
      Font.registerHyphenationCallback(word => [word])
      activeFontFamily = FONT_STACK_PDF
      pdfDebug('fonts: AlmaPDF registered', regular)
      resolve()
    }),
    PDF_FONT_TIMEOUT_MS,
    'font registration',
  ).catch(err => {
    pdfDebugError('fonts: Noto register failed, using Helvetica', err)
    useBuiltInHelvetica()
  })
}

export async function ensurePdfFonts(): Promise<void> {
  if (registered) return
  if (registerPromise) return registerPromise

  registerPromise = (async () => {
    if (pdfSafeMode()) {
      useBuiltInHelvetica()
      registered = true
      return
    }
    try {
      await registerNotoIfAvailable()
    } catch {
      useBuiltInHelvetica()
    }
    registered = true
  })()

  return registerPromise
}

export function resetPdfFonts(): void {
  registered = false
  registerPromise = null
  activeFontFamily = 'Helvetica'
}
