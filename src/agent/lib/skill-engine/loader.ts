/**
 * Skill Engine V2 — discovery → selection → activation (Phase B1 foundation).
 *
 * Progressive disclosure (roadmap §"Progressive-disclosure runtime"):
 *   1. DISCOVERY  — read only manifest + frontmatter (name/description/version/risk/
 *                   capabilities/keywords). Cheap; never loads the procedure body.
 *   2. SELECTION  — keyword/token routing → at most 3 skills (normally 1).
 *   3. ACTIVATION — load the chosen skill's SKILL.md body on demand.
 *
 * Deliberately NOT wired into the live turn yet. `compile` (skill → workflow + tool
 * pack + checklist), the completion-gate reuse, and head-prompt injection are the
 * next phases. Capability validation is INJECTED (knownCapabilities) so this module
 * stays decoupled from the heavy tool registry and unit-testable.
 */
import { promises as fs } from 'fs'
import path from 'path'
import type {
  ActivatedSkill,
  SkillIndex,
  SkillManifest,
  SkillMetadata,
} from '@/agent/lib/skill-engine/types'

const MAX_SKILLS_PER_TURN = 3
const SELECT_SCORE_THRESHOLD = 1

/** Split a SKILL.md into its `---` frontmatter map and the instruction body. */
export function parseFrontmatter(md: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md)
  if (!m) return { frontmatter: {}, body: md.trim() }
  const frontmatter: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key) frontmatter[key] = val
  }
  return { frontmatter, body: (m[2] ?? '').trim() }
}

function toKeywords(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[,|]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter(Boolean)
}

async function readManifest(dir: string): Promise<SkillManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')
    const m = JSON.parse(raw) as SkillManifest
    if (!m || typeof m.name !== 'string' || typeof m.version !== 'string') return null
    return m
  } catch {
    return null
  }
}

/**
 * DISCOVERY — scan a skills root for `<skill>/manifest.json` packages and build the
 * metadata index. Only `active` (and optionally `canary`) skills are offered.
 * `knownCapabilities`, when provided, flags any capability a skill references that is
 * not a real Alma tool/group (a skill can never call an invented handler).
 */
export async function discoverSkills(
  rootDir: string,
  opts: { knownCapabilities?: Set<string>; includeCanary?: boolean } = {},
): Promise<SkillIndex> {
  const skills: SkillMetadata[] = []
  const warnings: string[] = []

  let entries: string[] = []
  try {
    entries = (await fs.readdir(rootDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { skills, warnings: [`skills root not found: ${rootDir}`] }
  }

  for (const name of entries) {
    const dir = path.join(rootDir, name)
    const manifest = await readManifest(dir)
    if (!manifest) {
      warnings.push(`skip ${name}: missing/invalid manifest.json`)
      continue
    }
    const usable = manifest.status === 'active' || (opts.includeCanary && manifest.status === 'canary')
    if (!usable) continue

    if (opts.knownCapabilities) {
      const unknown = manifest.requiredCapabilities.filter((c) => !opts.knownCapabilities!.has(c))
      if (unknown.length) warnings.push(`${manifest.name}: unknown capabilities ${unknown.join(', ')}`)
    }

    let keywords: string[] = []
    try {
      const { frontmatter } = parseFrontmatter(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'))
      keywords = toKeywords(frontmatter.keywords)
    } catch {
      warnings.push(`${manifest.name}: SKILL.md unreadable`)
    }

    skills.push({
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      riskTier: manifest.riskTier,
      status: manifest.status,
      requiredCapabilities: manifest.requiredCapabilities,
      keywords,
      dir,
    })
  }

  return { skills, warnings }
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 2)
}

/**
 * SELECTION — keyword/token routing over the discovered metadata. Score = keyword
 * hits (weighted) + name/description token overlap. Returns at most 3 (roadmap cap),
 * highest score first, only above the threshold. Vector routing is a later add.
 */
export function selectSkills(index: SkillIndex, queryText: string, max = MAX_SKILLS_PER_TURN): SkillMetadata[] {
  const q = new Set(tokenize(queryText))
  if (q.size === 0) return []

  const scored = index.skills.map((s) => {
    let score = 0
    for (const kw of s.keywords) {
      // A multi-word keyword phrase present verbatim is a strong signal.
      if (kw.includes(' ')) {
        if (queryText.toLowerCase().includes(kw)) score += 3
      } else if (q.has(kw)) {
        score += 2
      }
    }
    for (const t of tokenize(`${s.name} ${s.description}`)) if (q.has(t)) score += 1
    return { s, score }
  })

  return scored
    .filter((x) => x.score >= SELECT_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, Math.min(max, MAX_SKILLS_PER_TURN)))
    .map((x) => x.s)
}

/** ACTIVATION — load the chosen skill's manifest + SKILL.md body on demand. */
export async function activateSkill(metadata: SkillMetadata): Promise<ActivatedSkill | null> {
  const manifest = await readManifest(metadata.dir)
  if (!manifest) return null
  let instructions = ''
  try {
    instructions = parseFrontmatter(await fs.readFile(path.join(metadata.dir, 'SKILL.md'), 'utf8')).body
  } catch {
    return null
  }
  return { metadata, manifest, instructions }
}
