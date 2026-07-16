/**
 * Phase 47 — internal-link graph: orphans, dead ends, click depth, and
 * ranked link suggestions. Pure functions over crawl output.
 */

export interface LinkPage {
  url: string
  internalLinks: string[]
}

export interface LinkGraph {
  nodes: Array<{
    url: string
    inDegree: number
    outDegree: number
    /** BFS depth from the home page; null = unreachable via internal links. */
    depth: number | null
  }>
  orphans: string[]
  deadEnds: string[]
  unreachable: string[]
}

const norm = (u: string) => u.replace(/\/$/, '')

/** Build the in/out-degree + depth picture of the site's internal links. */
export function buildLinkGraph(pages: LinkPage[], homeUrl: string): LinkGraph {
  const home = norm(homeUrl)
  const known = new Set(pages.map((p) => norm(p.url)))
  const inDegree = new Map<string, number>()
  const out = new Map<string, string[]>()

  for (const p of pages) {
    const from = norm(p.url)
    const targets = [...new Set(p.internalLinks.map(norm))].filter((t) => t !== from && known.has(t))
    out.set(from, targets)
    for (const t of targets) inDegree.set(t, (inDegree.get(t) ?? 0) + 1)
  }

  // BFS from home for click depth.
  const depth = new Map<string, number>()
  if (known.has(home)) {
    depth.set(home, 0)
    const queue = [home]
    while (queue.length) {
      const cur = queue.shift()!
      for (const next of out.get(cur) ?? []) {
        if (!depth.has(next)) {
          depth.set(next, depth.get(cur)! + 1)
          queue.push(next)
        }
      }
    }
  }

  const nodes = pages.map((p) => {
    const url = norm(p.url)
    return {
      url: p.url,
      inDegree: inDegree.get(url) ?? 0,
      outDegree: (out.get(url) ?? []).length,
      depth: depth.has(url) ? depth.get(url)! : null,
    }
  })

  return {
    nodes,
    orphans: nodes.filter((n) => n.inDegree === 0 && norm(n.url) !== home).map((n) => n.url),
    deadEnds: nodes.filter((n) => n.outDegree === 0).map((n) => n.url),
    unreachable: nodes.filter((n) => n.depth === null && norm(n.url) !== home).map((n) => n.url),
  }
}

export interface LinkSuggestion {
  from: string
  to: string
  reason: string
  priority: 'high' | 'medium'
}

/**
 * Rank internal-link fixes: orphaned/unreachable pages first (they get no
 * equity at all), then deep pages (>3 clicks from home). Suggested sources
 * are the highest-authority nodes (most inlinks) that already have outlinks.
 */
export function suggestInternalLinks(graph: LinkGraph, maxSuggestions = 10): LinkSuggestion[] {
  const sources = [...graph.nodes]
    .filter((n) => n.outDegree > 0 && n.depth !== null && n.depth <= 1)
    .sort((a, b) => b.inDegree - a.inDegree)
    .slice(0, 3)
  if (sources.length === 0) return []

  const suggestions: LinkSuggestion[] = []
  for (const url of [...new Set([...graph.orphans, ...graph.unreachable])]) {
    suggestions.push({
      from: sources[suggestions.length % sources.length].url,
      to: url,
      reason: 'orphan/unreachable — receives no internal link equity and may not be discovered',
      priority: 'high',
    })
    if (suggestions.length >= maxSuggestions) return suggestions
  }
  for (const n of graph.nodes.filter((n) => (n.depth ?? 0) > 3).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))) {
    suggestions.push({
      from: sources[suggestions.length % sources.length].url,
      to: n.url,
      reason: `${n.depth} clicks from home — too deep for crawl priority`,
      priority: 'medium',
    })
    if (suggestions.length >= maxSuggestions) break
  }
  return suggestions
}
