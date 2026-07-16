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

/**
 * No hyphenation for normal words, but a word longer than the page can hold
 * MUST be chunkable — `word => [word]` on a 30+ char token (URLs, file names)
 * sends react-pdf's line-breaker into an infinite loop and freezes the tab
 * (2026-07-16 client-report incident). 16-char chunks give the layout legal
 * break points; normal Bangla/English words stay whole.
 */
function safeHyphenation(word: string): string[] {
  if (word.length <= 22) return [word]
  return word.match(/.{1,16}/g) ?? [word]
}

function useBuiltInHelvetica(): void {
  activeFontFamily = 'Helvetica'
  try {
    Font.registerHyphenationCallback(safeHyphenation)
  } catch {
    /* already registered */
  }
  pdfDebug('fonts: built-in Helvetica (no remote fetch)')
}

async function registerNotoIfAvailable(timeoutMs: number = PDF_FONT_TIMEOUT_MS): Promise<void> {
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
      Font.registerHyphenationCallback(safeHyphenation)
      activeFontFamily = FONT_STACK_PDF
      pdfDebug('fonts: AlmaPDF registered', regular)
      resolve()
    }),
    timeoutMs,
    'font registration',
  ).catch(err => {
    pdfDebugError('fonts: Noto register failed, using Helvetica', err)
    useBuiltInHelvetica()
  })
}

export async function ensurePdfFonts(opts?: {
  /**
   * Bangla-first documents (client reports) are WORTHLESS in Helvetica — the
   * script renders as mojibake (2026-07-16 preview incident: safe-mode default
   * shipped a garbled client PDF). forceNoto ignores the safe-mode switch and
   * registers the local /fonts Noto Bengali anyway; the timeout guard still
   * protects against hangs, and genuine failure still falls back.
   */
  forceNoto?: boolean
  timeoutMs?: number
}): Promise<void> {
  // A forceNoto call must be able to UPGRADE an earlier safe-mode (Helvetica)
  // registration — the memoized result only stands when it already satisfies.
  if (registered && (!opts?.forceNoto || activeFontFamily === FONT_STACK_PDF)) return
  if (registerPromise && !opts?.forceNoto) return registerPromise

  registerPromise = (async () => {
    if (pdfSafeMode() && !opts?.forceNoto) {
      useBuiltInHelvetica()
      registered = true
      return
    }
    try {
      await registerNotoIfAvailable(opts?.timeoutMs)
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
