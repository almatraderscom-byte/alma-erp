/**
 * Client-report HTML template (2026-07-16 pivot). Professional report tools
 * don't hand-assemble PDFs — they render a designed HTML document and print
 * it with a real browser engine. Chrome's text stack shapes Bangla perfectly,
 * CSS owns page breaks/branding, and the same template previews in the app.
 *
 * Input: the agent's markdown artifact, parsed by markdown-blocks. Output: a
 * self-contained HTML string (fonts via same-origin /fonts @font-face) that
 * /api/assistant/artifacts/[id]/pdf prints to A4.
 */
import { parseMarkdownBlocks, type InlineSpan, type MarkdownBlock } from '@/lib/pdf/markdown-blocks'

const ACCENT = '#E07A5F'
const INK = '#1d1d2b'
const MUTED = '#6f6f7e'
const LINE = '#e6e0d6'
const WASH = '#faf6ef'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function spansHtml(spans: InlineSpan[]): string {
  return spans.map((s) => (s.bold ? `<strong>${esc(s.text)}</strong>` : esc(s.text))).join('')
}

function blockHtml(b: MarkdownBlock): string {
  switch (b.kind) {
    case 'heading':
      if (b.level === 1) return `<h1>${esc(b.text)}</h1>`
      if (b.level === 2) return `<h2><span class="tick"></span>${esc(b.text)}</h2>`
      return `<h3>${esc(b.text)}</h3>`
    case 'paragraph':
      return `<p>${spansHtml(b.spans)}</p>`
    case 'list':
      return b.ordered
        ? `<ol>${b.items.map((i) => `<li>${spansHtml(i)}</li>`).join('')}</ol>`
        : `<ul>${b.items.map((i) => `<li>${spansHtml(i)}</li>`).join('')}</ul>`
    case 'table': {
      const head = b.header.length
        ? `<thead><tr>${b.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
        : ''
      const body = b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('')
      return `<div class="tablewrap"><table>${head}<tbody>${body}</tbody></table></div>`
    }
    case 'divider':
      return '<hr/>'
  }
}

export interface ReportHtmlInput {
  markdown: string
  fallbackTitle: string
  /**
   * @font-face src URLs for Noto Sans Bengali. MUST be data: URIs when the
   * HTML is printed by headless Chromium on Vercel — the deployment's /fonts
   * URLs sit behind deployment protection (SSO), so the browser inside the
   * lambda gets an HTML login page instead of a TTF and every Bangla glyph
   * renders blank. See fontFaceSrcFromDisk() in the PDF route.
   */
  fonts: { regular: string; semiBold: string; bold: string }
  companyName?: string
  tagline?: string
}

export function buildReportHtml(input: ReportHtmlInput): { html: string; title: string } {
  let blocks = parseMarkdownBlocks(input.markdown)
  let title = input.fallbackTitle.replace(/\.(md|txt|html?)$/i, '')
  let metaLine = ''
  if (blocks[0]?.kind === 'heading' && blocks[0].level === 1) {
    title = blocks[0].text
    blocks = blocks.slice(1)
  }
  if (blocks[0]?.kind === 'paragraph') {
    const first = blocks[0].spans.map((s) => s.text).join('')
    if (/^(প্রস্তুত|Prepared|Date|তারিখ)/.test(first) && first.length < 120) {
      metaLine = first
      blocks = blocks.slice(1)
    }
  }
  const company = input.companyName ?? 'ALMA Digital'
  const tagline = input.tagline ?? 'Digital Growth & SEO'
  const initials = company.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

  const html = `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  @font-face { font-family: 'AlmaBn'; src: url('${input.fonts.regular}'); font-weight: 400; }
  @font-face { font-family: 'AlmaBn'; src: url('${input.fonts.semiBold}'); font-weight: 600; }
  @font-face { font-family: 'AlmaBn'; src: url('${input.fonts.bold}'); font-weight: 700; }
  * { box-sizing: border-box; }
  @page { size: A4; margin: 18mm 14mm 16mm 14mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'AlmaBn', 'Noto Sans Bengali', -apple-system, 'Segoe UI', sans-serif;
    color: ${INK}; font-size: 10.5pt; line-height: 1.7; background: #fff;
    word-break: break-word; overflow-wrap: anywhere;
  }
  .dochead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6mm; }
  .brand { display: flex; align-items: center; gap: 9px; }
  .logo {
    width: 46px; height: 38px; border: 1px solid ${LINE}; border-radius: 10px;
    background: ${WASH}; color: ${ACCENT}; font-weight: 700; font-size: 13pt;
    display: flex; align-items: center; justify-content: center;
  }
  .brand b { color: ${ACCENT}; font-size: 13pt; letter-spacing: .2px; }
  .brand small { display: block; color: ${MUTED}; font-size: 7pt; margin-top: 1px; }
  .doclabel { text-align: right; }
  .doclabel .kicker { font-size: 15pt; font-weight: 700; letter-spacing: 4px; color: ${INK}; }
  .doclabel .meta { font-size: 7.5pt; color: ${MUTED}; margin-top: 2px; }
  .rule { height: 2.5px; width: 46px; background: ${ACCENT}; border-radius: 2px; margin: 0 0 6mm; position: relative; }
  .rule:after { content: ''; position: absolute; left: 54px; right: 0; top: 1px; height: 1px; background: ${LINE}; }
  h1 { font-size: 15.5pt; font-weight: 700; line-height: 1.45; margin: 0 0 5mm; }
  h2 {
    font-size: 9pt; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase;
    color: ${MUTED}; margin: 8mm 0 2.5mm; display: flex; align-items: center; gap: 6px;
    break-after: avoid;
  }
  h2 .tick { width: 3.5px; height: 11px; border-radius: 2px; background: ${ACCENT}; display: inline-block; }
  h3 { font-size: 11pt; font-weight: 700; margin: 5mm 0 1.5mm; break-after: avoid; }
  p { margin: 0 0 2.8mm; }
  ul, ol { margin: 0 0 3.5mm; padding-left: 5.5mm; }
  li { margin-bottom: 1.4mm; }
  li::marker { color: ${ACCENT}; font-weight: 700; }
  .tablewrap { break-inside: auto; margin: 2mm 0 5mm; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid ${LINE}; border-radius: 10px; overflow: hidden; font-size: 9.2pt; }
  thead th {
    background: ${WASH}; color: #b45a41; text-align: left; font-size: 7.6pt;
    text-transform: uppercase; letter-spacing: .8px; padding: 2.4mm 3mm; border-bottom: 1px solid ${LINE};
  }
  tbody td { padding: 2.2mm 3mm; border-bottom: 1px solid #f0ebe2; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #fbf9f4; }
  tbody tr:last-child td { border-bottom: none; }
  tr, li { break-inside: avoid; }
  hr { border: none; border-top: 1px solid ${LINE}; margin: 6mm 0; }
  strong { font-weight: 700; }
  .foot { color: ${MUTED}; font-size: 7.5pt; text-align: center; margin-top: 10mm; }
</style>
</head>
<body>
  <div class="dochead">
    <div class="brand">
      <div class="logo">${esc(initials || 'AD')}</div>
      <div><b>${esc(company)}</b><small>${esc(tagline)}</small></div>
    </div>
    <div class="doclabel">
      <div class="kicker">REPORT</div>
      ${metaLine ? `<div class="meta">${esc(metaLine)}</div>` : ''}
    </div>
  </div>
  <div class="rule"></div>
  <h1>${esc(title)}</h1>
  ${blocks.map(blockHtml).join('\n')}
  <div class="foot">${esc(company)}</div>
</body>
</html>`
  return { html, title }
}
