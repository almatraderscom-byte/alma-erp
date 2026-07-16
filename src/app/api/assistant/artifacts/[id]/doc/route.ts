/**
 * Word export (owner ask 2026-07-16: "word file ba pdf file ar shundor kore
 * shajano dorkar"). Word/Pages/Google Docs all open an HTML file saved as
 * .doc and keep the styling — the standard lightweight docx-less approach.
 * Reuses the same branded template as the PDF, minus the data-URI fonts
 * (Word ignores @font-face; the font-family stack falls back to the reader's
 * installed Bangla faces, which every Mac/iPhone/Android ships).
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { buildReportHtml } from '@/lib/pdf/report-html'

export const runtime = 'nodejs'

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

  const kind = (artifact.type ?? '').toLowerCase()
  let html: string
  let title = (artifact.title ?? 'Artifact').replace(/\.(md|txt|html?|svg)$/i, '')
  if (kind === 'html' || kind === 'svg' || /^\s*(<!doctype html|<html[\s>]|<svg[\s>])/i.test(artifact.content)) {
    // Design artifacts open in Word as the page itself.
    html = /^\s*(<!doctype html|<html[\s>])/i.test(artifact.content)
      ? artifact.content
      : `<!doctype html><meta charset="utf-8">${artifact.content}`
  } else {
    const report = buildReportHtml({
      markdown: artifact.content,
      fallbackTitle: artifact.title ?? 'Report',
      // Word strips @font-face — rely on the reader's installed Bangla faces.
      fonts: null,
    })
    html = report.html
    title = report.title
  }

  const fileBase = title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120)
  return new Response(html, {
    headers: {
      'Content-Type': 'application/msword; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileBase)}.doc`,
      'Cache-Control': 'no-store',
    },
  })
}
