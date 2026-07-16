/**
 * Server-side client-report PDF (2026-07-16). The first cut rendered in the
 * browser and a full-length Bangla report froze the tab for minutes —
 * react-pdf's Bengali shaping is far too heavy for the UI thread. The render
 * now happens HERE: the panel's 📄 PDF button simply opens this URL and the
 * browser downloads a finished file.
 *
 * Fonts: Noto Bengali TTFs load from the local filesystem (public/fonts is
 * traced into this function via next.config outputFileTracingIncludes — the
 * creative-studio precedent). No safe-mode dance: server rendering can't
 * freeze anyone's tab, so the real font is always used.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import path from 'node:path'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const maxDuration = 120

let fontsRegistered = false

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

  try {
    const [{ Font, renderToBuffer }, React, { parseMarkdownBlocks }, { ClientReportDocument }] =
      await Promise.all([
        import('@react-pdf/renderer'),
        import('react'),
        import('@/lib/pdf/markdown-blocks'),
        import('@/components/pdf/ClientReportDocument'),
      ])

    if (!fontsRegistered) {
      const fontsDir = path.join(process.cwd(), 'public', 'fonts')
      Font.register({
        family: 'AlmaPDF',
        fonts: [
          { src: path.join(fontsDir, 'NotoSansBengali-Regular.ttf'), fontWeight: 400 },
          { src: path.join(fontsDir, 'NotoSansBengali-SemiBold.ttf'), fontWeight: 600 },
          { src: path.join(fontsDir, 'NotoSansBengali-Bold.ttf'), fontWeight: 700 },
        ],
      })
      // No hyphenation for normal words; 22+ char tokens (URLs, file names)
      // get 16-char chunks — an unbreakable over-wide token infinite-loops the
      // line breaker (the same class of hang, server edition would just 504).
      Font.registerHyphenationCallback((word: string) =>
        word.length <= 22 ? [word] : word.match(/.{1,16}/g) ?? [word],
      )
      fontsRegistered = true
    }

    let blocks = parseMarkdownBlocks(artifact.content)
    let title = (artifact.title ?? 'Report').replace(/\.(md|txt|html?)$/i, '')
    const metaLines: string[] = []
    if (blocks[0]?.kind === 'heading' && blocks[0].level === 1) {
      title = blocks[0].text
      blocks = blocks.slice(1)
    }
    if (blocks[0]?.kind === 'paragraph') {
      const first = blocks[0].spans.map((s) => s.text).join('')
      if (/^(প্রস্তুত|Prepared|Date|তারিখ)/.test(first) && first.length < 120) {
        metaLines.push(first)
        blocks = blocks.slice(1)
      }
    }

    const doc = React.createElement(ClientReportDocument, {
      model: { title, metaLines, blocks, fontFamily: 'AlmaPDF' },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await renderToBuffer(doc as any)

    const fileBase = (artifact.title ?? 'report')
      .replace(/\.(md|txt|html?)$/i, '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .slice(0, 120)
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileBase)}.pdf`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('[artifact-pdf] render failed:', err instanceof Error ? err.stack ?? err.message : err)
    // Owner-only route — surfacing the message here is the debuggability line
    // that saved this feature (Vercel log tailing kept missing the entry).
    return Response.json(
      { error: 'pdf_render_failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
