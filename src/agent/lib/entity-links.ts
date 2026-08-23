/**
 * Provider-neutral links to ALMA entities proven by structured tool output.
 *
 * This module deliberately does not scan arbitrary objects for `id` fields and
 * never accepts a URL authored by a model. Every extractor below names both the
 * tool and the exact output path, while every href comes from this route
 * allowlist. Adding a new entity therefore requires proving its detail route and
 * adding an explicit extractor here.
 */

import { ENTITY_ROUTE_BUSINESS_QUERY, type BusinessId } from '@/lib/businesses'

export const AGENT_ENTITY_ROUTES = {
  order: '/orders',
  employee: '/employees',
  trading_account: '/trading/accounts',
} as const

export type AgentEntityType = keyof typeof AGENT_ENTITY_ROUTES

export const AGENT_ENTITY_BUSINESSES: Readonly<Record<AgentEntityType, BusinessId>> = {
  order: 'ALMA_LIFESTYLE',
  employee: 'ALMA_LIFESTYLE',
  trading_account: 'ALMA_TRADING',
}

export interface AgentEntityLink {
  entityType: AgentEntityType
  entityId: string
  businessId: BusinessId
  label: string
  href: string
  /** Exact strings the deterministic renderer may turn into this link. */
  aliases?: string[]
}

export interface EntityLinkToolRecord {
  toolName: string
  output: unknown
  status?: string
}

export interface AgentEntityLinkContext {
  /** The server-resolved conversation business, never a model-authored value. */
  businessId?: BusinessId
}

type JsonObject = Record<string, unknown>

const MAX_ENTITY_LINKS = 20
const MAX_FOOTER_LINKS = 5
const SAFE_ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function object(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function rows(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(object).filter((row): row is JsonObject => row !== null)
    : []
}

function dataFromOutput(output: unknown): JsonObject | null {
  const envelope = object(output)
  if (!envelope) return null
  const data = object(envelope.data)
  return data ?? envelope
}

function safeEntityId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return SAFE_ENTITY_ID_RE.test(id) ? id : null
}

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const label = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return label || fallback
}

function uniqueAliases(values: unknown[]): string[] {
  const seen = new Set<string>()
  const aliases: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const alias = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120)
    if (alias.length < 2 || seen.has(alias.toLocaleLowerCase('en'))) continue
    seen.add(alias.toLocaleLowerCase('en'))
    aliases.push(alias)
  }
  return aliases
}

function makeLink(
  entityType: AgentEntityType,
  rawId: unknown,
  rawLabel: unknown,
  aliases: unknown[] = [],
): AgentEntityLink | null {
  const entityId = safeEntityId(rawId)
  if (!entityId) return null
  const fallback = `${entityType === 'trading_account' ? 'Trading account' : entityType} ${entityId}`
  const label = cleanLabel(rawLabel, fallback)
  const businessId = AGENT_ENTITY_BUSINESSES[entityType]
  return {
    entityType,
    entityId,
    businessId,
    label,
    href: `${AGENT_ENTITY_ROUTES[entityType]}/${encodeURIComponent(entityId)}?${ENTITY_ROUTE_BUSINESS_QUERY}=${businessId}`,
    aliases: uniqueAliases([label, ...aliases, entityId]),
  }
}

function orderLink(row: JsonObject): AgentEntityLink | null {
  const id = safeEntityId(row.id)
  if (!id) return null
  const orderNumber = typeof row.orderNumber === 'string'
    ? row.orderNumber.trim().replace(/^#+/, '')
    : ''
  const label = orderNumber ? `#${orderNumber}` : `Order ${id}`
  return makeLink('order', id, label, [
    orderNumber,
  ])
}

function employeeLink(row: JsonObject): AgentEntityLink | null {
  const id = row.id ?? row.employeeId
  const safeId = safeEntityId(id)
  if (!safeId) return null
  const name = cleanLabel(row.name, `Employee ${safeId}`)
  return makeLink('employee', safeId, name, [safeId])
}

function tradingAccountLink(row: JsonObject): AgentEntityLink | null {
  const id = safeEntityId(row.id)
  if (!id) return null
  const title = cleanLabel(row.accountTitle, `Trading account ${id}`)
  return makeLink('trading_account', id, title, [id])
}

type Extractor = (data: JsonObject) => Array<AgentEntityLink | null>

/** Explicit output paths only. Unknown tools and lookalike nested IDs are ignored. */
const TOOL_ENTITY_EXTRACTORS: Readonly<Record<string, Extractor>> = {
  get_orders: (data) => rows(data.orders).map(orderLink),
  get_customer_order_status: (data) => rows(data.orders)
    // A CS draft ID is not an ERP order ID and cannot open /orders/:id.
    .filter((row) => row.source === 'erp')
    .map(orderLink),
  check_order_issues: (data) => rows(data.issues).flatMap((issue) =>
    rows(issue.orderEntities).map(orderLink)),
  update_order: (data) => rows(data.orderEntities).map(orderLink),
  update_orders: (data) => rows(data.orderEntities).map(orderLink),
  order_lifecycle_scan: (data) => rows(data.orderEntities).map(orderLink),
  get_employee_overview: (data) => rows(data.employees).map(employeeLink),
  // /employees/:id currently opens the Lifestyle HR roster. Attendance from a
  // Trading/CDIT business may use a different employee namespace, so it must
  // stay plain text until the route carries business context.
  get_attendance: (data) => data.businessId === 'ALMA_LIFESTYLE'
    ? [
        ...rows(data.employees),
        ...rows(data.present),
        ...rows(data.late),
        ...rows(data.absent),
        ...rows(data.penalties),
      ].map(employeeLink)
    : [],
  get_trading_accounts: (data) => rows(data.accounts).map(tradingAccountLink),
  get_trading_account_detail: (data) => [tradingAccountLink(object(data.account) ?? {})],
  // A specialist can execute any allowlisted tool above. Delegation carries
  // only its already-verified flat metadata; arbitrary nested IDs remain inert.
  delegate_to_specialist: (data) => Array.isArray(data.entityLinks)
    ? data.entityLinks.map((link) => isCanonicalEntityLink(link) ? link : null)
    : [],
}

function isCanonicalEntityLink(value: unknown): value is AgentEntityLink {
  const candidate = object(value)
  if (!candidate) return false
  const entityType = candidate.entityType
  const entityId = safeEntityId(candidate.entityId)
  if (
    (entityType !== 'order' && entityType !== 'employee' && entityType !== 'trading_account')
    || !entityId
  ) return false
  const businessId = AGENT_ENTITY_BUSINESSES[entityType]
  return candidate.businessId === businessId
    && candidate.href === `${AGENT_ENTITY_ROUTES[entityType]}/${encodeURIComponent(entityId)}?${ENTITY_ROUTE_BUSINESS_QUERY}=${businessId}`
    && typeof candidate.label === 'string'
    && candidate.label.trim().length > 0
    && (candidate.aliases == null
      || (Array.isArray(candidate.aliases) && candidate.aliases.every((alias) => typeof alias === 'string')))
}

export function mergeAgentEntityLinks(
  ...groups: ReadonlyArray<ReadonlyArray<AgentEntityLink>>
): AgentEntityLink[] {
  const merged: AgentEntityLink[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const link of group) {
      if (!isCanonicalEntityLink(link)) continue
      const key = `${link.businessId}:${link.entityType}:${link.entityId}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({
        ...link,
        label: cleanLabel(link.label, `${link.entityType} ${link.entityId}`),
        aliases: uniqueAliases(link.aliases ?? []),
      })
      if (merged.length >= MAX_ENTITY_LINKS) return merged
    }
  }
  return merged
}

/** Prevent a valid ID from one business namespace becoming a route in another. */
export function filterAgentEntityLinksForBusiness(
  links: ReadonlyArray<AgentEntityLink>,
  context: AgentEntityLinkContext = {},
): AgentEntityLink[] {
  const canonical = mergeAgentEntityLinks(links)
  if (context.businessId) return canonical.filter((link) => link.businessId === context.businessId)
  return canonical
}

export function extractAgentEntityLinks(
  toolName: string,
  output: unknown,
  context: AgentEntityLinkContext = {},
): AgentEntityLink[] {
  const extractor = TOOL_ENTITY_EXTRACTORS[toolName]
  const data = dataFromOutput(output)
  if (!extractor || !data) return []
  return filterAgentEntityLinksForBusiness(
    extractor(data).filter((link): link is AgentEntityLink => link !== null),
    context,
  )
}

export function extractAgentEntityLinksFromRecords(
  records: ReadonlyArray<EntityLinkToolRecord>,
  context: AgentEntityLinkContext = {},
): AgentEntityLink[] {
  return mergeAgentEntityLinks(...records
    .filter((record) => record.status == null || record.status === 'success')
    .map((record) => extractAgentEntityLinks(record.toolName, record.output, context)))
}

/** Add verified references to the result envelope once, at the common executor. */
export function enrichToolResultWithEntityLinks<
  T extends { success: boolean; data?: unknown; entityLinks?: AgentEntityLink[] },
>(
  toolName: string,
  result: T,
  context: AgentEntityLinkContext = {},
): T & { entityLinks?: AgentEntityLink[] } {
  if (!result.success) return { ...result, entityLinks: undefined }
  const entityLinks = filterAgentEntityLinksForBusiness(
    mergeAgentEntityLinks(
      result.entityLinks ?? [],
      extractAgentEntityLinks(toolName, { data: result.data }, context),
    ),
    context,
  )
  // Always replace handler-authored metadata with the canonical filtered set.
  // `undefined` is omitted from JSON, so a wrong-business link cannot leak.
  return { ...result, entityLinks: entityLinks.length > 0 ? entityLinks : undefined }
}

type Range = { start: number; end: number; kind: 'code' | 'link' }

function protectedMarkdownRanges(text: string): Range[] {
  const ranges: Range[] = []
  const add = (pattern: RegExp, kind: Range['kind']) => {
    for (const match of text.matchAll(pattern)) {
      if (match.index == null) continue
      ranges.push({ start: match.index, end: match.index + match[0].length, kind })
    }
  }
  // Unclosed fences are protected through EOF; a renderer must never inject into code.
  add(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, 'code')
  add(/`[^`\n]*`/g, 'code')
  add(/!?\[[^\]\n]*(?:\\.[^\]\n]*)*\]\((?:\\.|[^)\n])*\)/g, 'link')
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Range[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range.start < previous.end) {
      if (range.end > previous.end) previous.end = range.end
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

function markdownHref(fragment: string): string | null {
  const match = /\]\(([^\s)]+)(?:\s+['"][^'"]*['"])?\)$/.exec(fragment)
  return match?.[1] ?? null
}

function isWordChar(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}_]/u.test(value))
}

function validMentionBoundary(text: string, start: number, length: number, alias: string): boolean {
  const before = start > 0 ? text[start - 1] : undefined
  const after = start + length < text.length ? text[start + length] : undefined
  if (isWordChar(alias[0]) && isWordChar(before)) return false
  if (isWordChar(alias[alias.length - 1]) && isWordChar(after)) return false
  // Never rewrite a raw URL/path/query value into nested Markdown.
  if (before === '/' || before === '=' || before === '?') return false
  return true
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/([\\\[\]])/g, '\\$1')
}

function linkifyPlainSegment(
  segment: string,
  links: ReadonlyArray<AgentEntityLink>,
  resolvedHrefs: Set<string>,
): string {
  type Candidate = {
    start: number
    end: number
    link: AgentEntityLink
    text: string
    isEntityId: boolean
    linkIndex: number
  }

  // Names are not identities. If two verified records share an alias (for
  // example two employees named "Alex"), leave that alias plain and require a
  // unique alias or the stable record ID. This prevents a plausible name from
  // navigating to whichever row happened to arrive first.
  const aliasOwners = new Map<string, Set<string>>()
  const aliasesByLink = links.map((link) => {
    const aliases = uniqueAliases(link.aliases?.length ? link.aliases : [link.label, link.entityId])
    const owner = `${link.entityType}:${link.entityId}`
    for (const alias of aliases) {
      const key = alias.toLocaleLowerCase('en')
      const owners = aliasOwners.get(key) ?? new Set<string>()
      owners.add(owner)
      aliasOwners.set(key, owners)
    }
    return aliases
  })

  const lower = segment.toLocaleLowerCase('en')
  const candidates: Candidate[] = []
  for (const [linkIndex, link] of links.entries()) {
    if (resolvedHrefs.has(link.href)) continue
    for (const alias of aliasesByLink[linkIndex]) {
      const needle = alias.toLocaleLowerCase('en')
      const isEntityId = needle === link.entityId.toLocaleLowerCase('en')
      if (!isEntityId && (aliasOwners.get(needle)?.size ?? 0) > 1) continue
      let from = 0
      while (from <= lower.length - needle.length) {
        const start = lower.indexOf(needle, from)
        if (start < 0) break
        if (validMentionBoundary(segment, start, alias.length, alias)) {
          candidates.push({
            start,
            end: start + alias.length,
            link,
            text: segment.slice(start, start + alias.length),
            isEntityId,
            linkIndex,
          })
        }
        from = start + Math.max(1, needle.length)
      }
    }
  }

  // Resolve every match against the untouched segment. Longest aliases win an
  // overlap ("Alex Khan" over "Alex"); stable IDs break equal-length ties.
  candidates.sort((a, b) =>
    (b.end - b.start) - (a.end - a.start)
    || Number(b.isEntityId) - Number(a.isEntityId)
    || a.start - b.start
    || a.linkIndex - b.linkIndex)

  const selected: Candidate[] = []
  const selectedHrefs = new Set<string>()
  for (const candidate of candidates) {
    if (selectedHrefs.has(candidate.link.href)) continue
    if (selected.some((picked) => candidate.start < picked.end && picked.start < candidate.end)) continue
    selected.push(candidate)
    selectedHrefs.add(candidate.link.href)
  }

  let rendered = segment
  for (const candidate of selected.sort((a, b) => b.start - a.start)) {
    rendered = rendered.slice(0, candidate.start)
      + `[${escapeMarkdownLabel(candidate.text)}](${candidate.link.href})`
      + rendered.slice(candidate.end)
    resolvedHrefs.add(candidate.link.href)
  }
  return rendered
}

export interface LinkifyEntityTextOptions {
  /** On a final answer, expose a compact fallback when no entity was named in prose. */
  appendUnmentioned?: boolean
  /** Set false at a late convergence point that may only safely append a delta. */
  linkMentions?: boolean
}

/**
 * Link exact mentions outside code and existing Markdown links. If a final reply
 * names none of its verified entities, append up to five deterministic links.
 */
export function linkifyAgentEntityText(
  text: string,
  rawLinks: ReadonlyArray<AgentEntityLink>,
  options: LinkifyEntityTextOptions = {},
): string {
  const links = mergeAgentEntityLinks(rawLinks)
  if (!text || links.length === 0) return text

  const protectedRanges = protectedMarkdownRanges(text)
  const resolvedHrefs = new Set<string>()
  const canonicalHrefs = new Set(links.map((link) => link.href))
  for (const range of protectedRanges) {
    if (range.kind !== 'link') continue
    const href = markdownHref(text.slice(range.start, range.end))
    // External citations and model-invented ALMA paths prove nothing about the
    // verified entities for this turn and must not suppress the fallback.
    if (href && canonicalHrefs.has(href)) resolvedHrefs.add(href)
  }

  let rendered = text
  if (options.linkMentions !== false) {
    let cursor = 0
    rendered = ''
    for (const range of protectedRanges) {
      if (range.start > cursor) {
        rendered += linkifyPlainSegment(text.slice(cursor, range.start), links, resolvedHrefs)
      }
      rendered += text.slice(range.start, range.end)
      cursor = range.end
    }
    if (cursor < text.length) {
      rendered += linkifyPlainSegment(text.slice(cursor), links, resolvedHrefs)
    }
  }

  const lastProtected = protectedRanges[protectedRanges.length - 1]
  const endsInsideCode = lastProtected?.kind === 'code'
    && lastProtected.end === text.length
    && !/(```|~~~)\s*$/.test(text.slice(lastProtected.start))
  if (options.appendUnmentioned && resolvedHrefs.size === 0 && !endsInsideCode) {
    const footerLinks = links.slice(0, MAX_FOOTER_LINKS)
      .map((link) => `[${escapeMarkdownLabel(link.label)}](${link.href})`)
    if (footerLinks.length > 0) {
      rendered += `${rendered.trimEnd() ? '\n\n' : ''}খুলুন: ${footerLinks.join(' · ')}`
    }
  }
  return rendered
}
