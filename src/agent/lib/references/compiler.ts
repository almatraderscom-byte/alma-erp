import type { AgentReferenceV1 } from './types'
import { mergeAgentReferences } from './validator'
import { shouldRenderAgentReferences } from './flags'

type TextReference = { refId: string; href: string; label: string; aliases: string[] }
type Range = { start: number; end: number; kind: 'code' | 'link' }

function hrefForReference(reference: AgentReferenceV1): string {
  switch (reference.destination.type) {
    case 'internal_section': return reference.destination.webPath
    case 'internal_entity': return reference.destination.webPath
    case 'artifact_report': return reference.destination.apiPath
    default: return reference.destination.url
  }
}

export function verifiedHrefSet(references: ReadonlyArray<unknown>): Set<string> {
  return new Set(mergeAgentReferences(references).map(hrefForReference))
}

function cleanAlias(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const alias = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  return alias.length >= 2 ? alias : null
}

function toTextReferences(references: ReadonlyArray<unknown>): TextReference[] {
  return mergeAgentReferences(references).map((reference) => {
    const aliases: string[] = []
    const seen = new Set<string>()
    for (const raw of [reference.label, ...(reference.aliases ?? []), reference.entity?.id]) {
      const alias = cleanAlias(raw)
      if (!alias) continue
      const key = alias.toLocaleLowerCase('en')
      if (seen.has(key)) continue
      seen.add(key)
      aliases.push(alias)
    }
    return { refId: reference.refId, href: hrefForReference(reference), label: reference.label, aliases }
  })
}

function protectedRanges(text: string): Range[] {
  const ranges: Range[] = []
  const add = (pattern: RegExp, kind: Range['kind']) => {
    for (const match of text.matchAll(pattern)) {
      if (match.index == null) continue
      ranges.push({ start: match.index, end: match.index + match[0].length, kind })
    }
  }
  add(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, 'code')
  add(/`[^`\n]*`/g, 'code')
  add(/!?\[[^\]\n]*(?:\\.[^\]\n]*)*\]\((?:<[^>\n]*>|(?:\\.|[^)\n])*)\)/g, 'link')
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Range[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function markdownHref(fragment: string): string | null {
  const match = /\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+['"][^'"]*['"])?\)$/.exec(fragment)
  return match?.[1] ?? match?.[2] ?? null
}

function markdownDestination(href: string): string {
  return `<${href}>`
}

function escapeLabel(label: string): string {
  return label.replace(/([\\\[\]])/g, '\\$1')
}

function word(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}_]/u.test(value))
}

function hasBoundary(text: string, start: number, alias: string): boolean {
  const before = text[start - 1]
  const after = text[start + alias.length]
  if (word(alias[0]) && word(before)) return false
  if (word(alias.at(-1)) && word(after)) return false
  return before !== '/' && before !== '=' && before !== '?'
}

function linkPlainSegment(
  text: string,
  references: TextReference[],
  resolved: Set<string>,
): string {
  type Candidate = { start: number; end: number; ref: TextReference; alias: string; refIndex: number }
  const aliasOwners = new Map<string, Set<string>>()
  for (const ref of references) {
    for (const alias of ref.aliases) {
      const key = alias.toLocaleLowerCase('en')
      const owners = aliasOwners.get(key) ?? new Set<string>()
      owners.add(ref.refId)
      aliasOwners.set(key, owners)
    }
  }

  const lower = text.toLocaleLowerCase('en')
  const candidates: Candidate[] = []
  references.forEach((ref, refIndex) => {
    if (resolved.has(ref.href)) return
    for (const alias of ref.aliases) {
      const needle = alias.toLocaleLowerCase('en')
      if ((aliasOwners.get(needle)?.size ?? 0) > 1 && needle !== ref.refId.toLocaleLowerCase('en')) continue
      let offset = 0
      while (offset <= lower.length - needle.length) {
        const start = lower.indexOf(needle, offset)
        if (start < 0) break
        if (hasBoundary(text, start, alias)) candidates.push({ start, end: start + alias.length, ref, alias, refIndex })
        offset = start + Math.max(1, needle.length)
      }
    }
  })
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start || a.refIndex - b.refIndex)
  const selected: Candidate[] = []
  const selectedRefs = new Set<string>()
  for (const candidate of candidates) {
    if (selectedRefs.has(candidate.ref.refId)) continue
    if (selected.some((picked) => candidate.start < picked.end && picked.start < candidate.end)) continue
    selected.push(candidate)
    selectedRefs.add(candidate.ref.refId)
  }
  let rendered = text
  for (const candidate of selected.sort((a, b) => b.start - a.start)) {
    const visible = rendered.slice(candidate.start, candidate.end)
    rendered = `${rendered.slice(0, candidate.start)}[${escapeLabel(visible)}](${markdownDestination(candidate.ref.href)})${rendered.slice(candidate.end)}`
    resolved.add(candidate.ref.href)
  }
  return rendered
}

export interface CompileAgentReferenceOptions {
  appendUnmentioned?: boolean
  linkMentions?: boolean
}

/** Deterministic final-text compiler. It never trusts or invents a destination. */
export function compileAgentReferenceText(
  text: string,
  rawReferences: ReadonlyArray<unknown>,
  options: CompileAgentReferenceOptions = {},
): string {
  if (!text || !shouldRenderAgentReferences()) return text
  const references = toTextReferences(rawReferences)
  if (references.length === 0) return text
  const ranges = protectedRanges(text)
  const verifiedHrefs = new Set(references.map((reference) => reference.href))
  const resolved = new Set<string>()
  for (const range of ranges) {
    if (range.kind !== 'link') continue
    const href = markdownHref(text.slice(range.start, range.end))
    if (href && verifiedHrefs.has(href)) resolved.add(href)
  }

  let rendered = text
  if (options.linkMentions !== false) {
    rendered = ''
    let cursor = 0
    for (const range of ranges) {
      if (range.start > cursor) rendered += linkPlainSegment(text.slice(cursor, range.start), references, resolved)
      rendered += text.slice(range.start, range.end)
      cursor = range.end
    }
    if (cursor < text.length) rendered += linkPlainSegment(text.slice(cursor), references, resolved)
  }

  const last = ranges.at(-1)
  const unclosedFence = last?.kind === 'code' && last.end === text.length && !/(```|~~~)\s*$/.test(text.slice(last.start))
  if (options.appendUnmentioned && resolved.size === 0 && !unclosedFence) {
    const footer = references.slice(0, 6).map((reference) =>
      `[${escapeLabel(reference.label)}](${markdownDestination(reference.href)})`)
    if (footer.length) rendered += `${rendered.trimEnd() ? '\n\n' : ''}রেফারেন্স: ${footer.join(' · ')}`
  }
  return rendered
}
