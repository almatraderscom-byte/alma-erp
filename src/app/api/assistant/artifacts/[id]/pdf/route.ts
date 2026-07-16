/**
 * Client-report PDF — the professional pipeline (2026-07-16 final pivot).
 *
 * History of this route in one day: browser react-pdf froze the tab on long
 * Bangla docs; server react-pdf 500'd and its Bengali shaping/design ceiling
 * was low anyway. Professional report tools render a DESIGNED HTML template
 * and print it with a real browser engine — so that's what this does:
 *
 *   artifact markdown → buildReportHtml (aura-styled, print CSS)
 *   → headless Chromium (@sparticuz/chromium on Vercel, local Chrome in dev)
 *   → page.pdf() → attachment download.
 *
 * Chrome's text stack shapes Bangla perfectly, CSS owns page breaks, and the
 * template can grow charts/score cards without touching PDF primitives.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { existsSync } from 'node:fs'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { buildReportHtml } from '@/lib/pdf/report-html'

export const runtime = 'nodejs'
export const maxDuration = 120

/** Local dev fallbacks — @sparticuz/chromium only ships lambda binaries. */
const LOCAL_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
]

async function launchBrowser() {
  const puppeteer = (await import('puppeteer-core')).default
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const chromium = (await import('@sparticuz/chromium')).default
    // No WebGL needed for print — skips the GPU .so extraction (and v131's
    // libnss3 failure came from a runtime/library mismatch; ≥149 ships the
    // AL2023 lib set Vercel's node runtime actually has).
    chromium.setGraphicsMode = false
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    })
  }
  const local = LOCAL_CHROME_PATHS.find((p) => existsSync(p))
  if (!local) throw new Error('no local Chrome found for PDF rendering')
  return puppeteer.launch({ executablePath: local, headless: true })
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const artifact = await db.agentArtifact.findUnique({
    where: { id: params.id },
    select: { id: true, title: true, content: true, type: true },
  })
  if (!artifact?.content) return Response.json({ error: 'not_found' }, { status: 404 })

  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null
  try {
    const origin = req.nextUrl.origin
    const { html, title } = buildReportHtml({
      markdown: artifact.content,
      fallbackTitle: artifact.title ?? 'Report',
      origin,
    })

    browser = await launchBrowser()
    const page = await browser.newPage()
    // Fonts load from /fonts on this same deployment — wait for them so the
    // first page isn't measured with a fallback face.
    await page.setContent(html, { waitUntil: 'load', timeout: 60_000 })
    await page.evaluateHandle('document.fonts.ready')
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    })

    const fileBase = title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120)
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileBase)}.pdf`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('[artifact-pdf] render failed:', err instanceof Error ? err.stack ?? err.message : err)
    // Owner-only route — the message here is the debug line (log tailing kept
    // missing these entries all day).
    return Response.json(
      { error: 'pdf_render_failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  } finally {
    try { await browser?.close() } catch { /* already gone */ }
  }
}
