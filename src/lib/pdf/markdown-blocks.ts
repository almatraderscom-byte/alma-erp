/**
 * Markdown → typed blocks for the client-report PDF (owner ask 2026-07-16:
 * "client report word/pdf file, shundor kore shajano" — the agent's markdown
 * artifacts must export as a DESIGNED A4 PDF, not a text dump).
 *
 * Deliberately small: the agent's reports use headings, paragraphs, bullet
 * lists and pipe tables — that's the whole grammar. Inline markdown (**bold**,
 * `code`, [text](url)) is flattened to plain text with the bold segments kept
 * as spans so the PDF can weight them. No external dependency: react-pdf
 * renders primitives, so an AST library would still need this flattening.
 */

export type InlineSpan = { text: string; bold?: boolean }

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; spans: InlineSpan[] }
  | { kind: 'list'; ordered: boolean; items: InlineSpan[][] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'divider' }

/** Strip inline markdown, keeping **bold** as weighted spans. */
export function parseInline(text: string): InlineSpan[] {
  const cleaned = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images gone
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .replace(/`([^`]+)`/g, '$1')
  const spans: InlineSpan[] = []
  const re = /\*\*([^*]+)\*\*|__([^_]+)__/g
  let last = 0
  for (let m = re.exec(cleaned); m; m = re.exec(cleaned)) {
    if (m.index > last) spans.push({ text: cleaned.slice(last, m.index) })
    spans.push({ text: m[1] ?? m[2] ?? '', bold: true })
    last = m.index + m[0].length
  }
  if (last < cleaned.length) spans.push({ text: cleaned.slice(last) })
  // Residual single *italics* markers read as noise in a client PDF — drop them.
  return spans
    .map((s) => ({ ...s, text: s.text.replace(/(^|\s)\*([^*]+)\*(?=\s|$|[,.;:!?])/g, '$1$2') }))
    .filter((s) => s.text.length > 0)
}

export function spansToText(spans: InlineSpan[]): string {
  return spans.map((s) => s.text).join('')
}

function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && t.length > 2
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => spansToText(parseInline(c.trim())))
}

function isDividerRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '')))
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = (markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: InlineSpan[][] } | null = null

  const flushPara = () => {
    const text = para.join(' ').trim()
    if (text) blocks.push({ kind: 'paragraph', spans: parseInline(text) })
    para = []
  }
  const flushList = () => {
    if (list && list.items.length) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()

    if (!t) { flushPara(); flushList(); continue }

    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) {
      flushPara(); flushList()
      const level = Math.min(h[1].length, 3) as 1 | 2 | 3
      blocks.push({ kind: 'heading', level, text: spansToText(parseInline(h[2])) })
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); flushList(); blocks.push({ kind: 'divider' }); continue }

    if (isTableRow(t)) {
      flushPara(); flushList()
      const rows: string[][] = []
      let j = i
      while (j < lines.length && isTableRow(lines[j])) { rows.push(splitRow(lines[j])); j++ }
      i = j - 1
      if (rows.length >= 2 && isDividerRow(rows[1])) {
        blocks.push({ kind: 'table', header: rows[0], rows: rows.slice(2) })
      } else if (rows.length >= 1) {
        // Headerless pipe rows still deserve table treatment.
        blocks.push({ kind: 'table', header: [], rows })
      }
      continue
    }

    const ul = /^[-*+]\s+(.*)$/.exec(t)
    const ol = /^\d+[.)]\s+(.*)$/.exec(t)
    if (ul || ol) {
      flushPara()
      const ordered = Boolean(ol)
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] } }
      list.items.push(parseInline((ul?.[1] ?? ol?.[1] ?? '').trim()))
      continue
    }

    if (list) {
      // Indented continuation of the previous bullet.
      if (/^\s{2,}/.test(line)) {
        const item = list.items[list.items.length - 1]
        item.push({ text: ' ' + spansToText(parseInline(t)) })
        continue
      }
      flushList()
    }
    para.push(t)
  }
  flushPara(); flushList()
  return blocks
}
