/**
 * Shared model-facing tool policy for owner turns.
 *
 * The native and provider-adapter loops both use this pure composition so an
 * initial schema and a schema discovered through find_tool have the same
 * authorization, health, mode and schema-minimization treatment.
 */
import type { AgentControls } from '@/agent/lib/agent-controls'
import { filterToolDefsByControls } from '@/agent/lib/agent-controls'
import type { ChatMode } from '@/agent/lib/chat-mode'
import { filterToolsForMode } from '@/agent/lib/chat-mode'
import { EXPLICIT_CHROME_MODALITY_TOOLS } from '@/agent/lib/live-browser/modality'
import { filterToolsForOwnerIntent } from '@/agent/lib/owner-intent-contract'
import type { PermissionMode } from '@/agent/lib/permission-mode'
import { filterToolsForPermissionMode } from '@/agent/lib/permission-mode'
import type { OwnerTurnAuthorization } from '@/agent/lib/turn-authorization'
import { filterToolsForOwnerTurn } from '@/agent/lib/turn-authorization'
import {
  effectiveHealth,
  evaluatePermission,
  isAvailable,
  capabilityStore,
  type CapabilityScope,
} from '@/agent/capabilities'
import { getCapability } from '@/agent/tools/capability-manifest'
import { getManifest } from '@/agent/tools/manifests'
import { callability } from '@/agent/tools/registry/deprecation'
import { minimizeSchema } from '@/agent/tools/selection/schema-minimizer'
import { selectShortlist } from '@/agent/tools/selection/shortlist'
import {
  resolveToolsByName,
  searchToolInventoryWithSemanticFallback,
} from '@/agent/tools/find-tool'

export interface TurnToolDefinition {
  name: string
  description?: string
  input_schema: unknown
}

export interface TurnToolPolicy {
  ownerText: string
  turnAllowlist: Set<string> | null
  turnDenylist: Set<string>
  turnAuthorization: OwnerTurnAuthorization
  agentControls: AgentControls
  chatMode: ChatMode
  permissionMode: PermissionMode
  actorRoles?: CapabilityScope[]
  ownerIntentGateEnabled?: boolean
  /** Test seam and future durable-health adapter. */
  isCatalogAvailable?: (name: string) => boolean
}

export interface FindToolResultLike {
  data?: { matches?: Array<{ name?: unknown }>; note?: unknown }
}

/** A modality widens only a pinned skill's list; an unpinned turn stays open. */
export function composeTurnToolAllowlist(
  skillAllowlist: Set<string> | null,
  explicitChrome: boolean,
): Set<string> | null {
  if (!skillAllowlist) return null
  const composed = new Set(skillAllowlist)
  if (explicitChrome) {
    for (const name of EXPLICIT_CHROME_MODALITY_TOOLS) composed.add(name)
  }
  return composed
}

/**
 * Remove unusable discovery matches in place. Callers run this immediately
 * after the handler returns, before any preview, event, timeline or transcript
 * is built from the result.
 */
export function filterFindToolResultForTurn(
  res: FindToolResultLike | undefined,
  opts: {
    already: Set<string>
    turnDenylist: Set<string>
    turnAllowlist: Set<string> | null
    /** Optional post-policy/post-health/post-shortlist names. */
    permittedNames?: Set<string>
  },
): { permitted: string[]; refused: string[] } {
  const matchNames = (res?.data?.matches ?? [])
    .map((match) => String(match?.name ?? ''))
    .filter(Boolean)
  if (matchNames.length === 0) return { permitted: [], refused: [] }

  const permitted = matchNames.filter((name) => {
    if (opts.already.has(name)) return false
    if (opts.turnDenylist.has(name)) return false
    if (opts.turnAllowlist && !opts.turnAllowlist.has(name)) return false
    if (opts.permittedNames && !opts.permittedNames.has(name)) return false
    return true
  })
  const refused = matchNames.filter(
    (name) => !opts.already.has(name) && !permitted.includes(name),
  )
  if (refused.length > 0 && res?.data && Array.isArray(res.data.matches)) {
    const refusedSet = new Set(refused)
    res.data.matches = res.data.matches.filter(
      (match) => !refusedSet.has(String(match?.name ?? '')),
    )
    res.data.note =
      `${typeof res.data.note === 'string' ? res.data.note : ''}`
      + `\n\n[হারনেস] ${refused.length}টি match এই টার্নে অনুমোদিত নয় বলে বাদ। `
      + 'বাদ দেওয়া tool call কোরো না — বিকল্প: অনুমোদিত tool ব্যবহার করো, '
      + 'নয়তো Boss-কে বলো এই ধাপে টুলটা অনুমোদিত নেই।'
  }
  return { permitted, refused }
}

/** Shared native/alternate handler boundary for permission-aware discovery. */
export async function prepareFindToolResultForTurn(input: {
  result: FindToolResultLike
  query: string
  already: Set<string>
  policy: TurnToolPolicy
  max: number
}): Promise<{
  tools: TurnToolDefinition[]
  permitted: string[]
  refused: string[]
  trimmed: string[]
}> {
  const candidates = input.query
    ? await searchToolInventoryWithSemanticFallback(input.query, Math.max(input.max * 4, input.max))
    : []
  if (input.result.data && candidates.length > 0) input.result.data.matches = candidates
  const names = (input.result.data?.matches ?? [])
    .map((match) => String(match?.name ?? ''))
    .filter((name) => Boolean(name) && !input.already.has(name))
  const resolved = await resolveToolsByName(names)
  const policyFiltered = filterTurnToolDefinitions(resolved, input.policy)
  const shortlisted = shortlistAvailableToolDefinitions(policyFiltered.tools, { max: input.max })
  const permittedNames = new Set(shortlisted.tools.map((tool) => tool.name))
  const filteredResult = filterFindToolResultForTurn(input.result, {
    already: input.already,
    turnDenylist: input.policy.turnDenylist,
    turnAllowlist: input.policy.turnAllowlist,
    permittedNames,
  })
  return {
    tools: shortlisted.tools,
    permitted: filteredResult.permitted,
    refused: filteredResult.refused,
    trimmed: shortlisted.trimmed,
  }
}

/** G08 lifecycle + G09 actor permission/declared health. Unknown legacy tools fail open. */
export function isCatalogToolAvailable(
  name: string,
  actorRoles: CapabilityScope[] = ['owner'],
): boolean {
  const manifest = getManifest(name)
  if (!manifest) return true
  if (!callability(manifest).callable) return false

  const capability = capabilityStore.getByKey(manifest.domain)
  if (!capability) return true
  if (evaluatePermission(capability, { roles: actorRoles }).decision !== 'allow') return false
  return isAvailable(effectiveHealth(capability))
}

function toolIsReadOnly(name: string): boolean {
  return getCapability(name)?.mode === 'read'
}

/**
 * Apply the same restrictions in the same order to every model-facing schema.
 * The schema is minimized from the authoritative runtime definition passed by
 * the caller; generated placeholder schemas are never consulted here.
 */
export function filterTurnToolDefinitions<T extends TurnToolDefinition>(
  tools: readonly T[],
  policy: TurnToolPolicy,
): { tools: T[]; removed: string[] } {
  const originalNames = tools.map((tool) => tool.name)
  const catalogAvailable = policy.isCatalogAvailable
    ?? ((name: string) => isCatalogToolAvailable(name, policy.actorRoles ?? ['owner']))

  let filtered = tools.filter((tool) => {
    if (policy.turnDenylist.has(tool.name)) return false
    if (policy.turnAllowlist && !policy.turnAllowlist.has(tool.name)) return false
    return catalogAvailable(tool.name)
  })
  if (policy.ownerIntentGateEnabled !== false) {
    filtered = filterToolsForOwnerIntent(policy.ownerText, [...filtered])
  }
  filtered = filterToolsForOwnerTurn(filtered, policy.turnAuthorization)
  filtered = filterToolDefsByControls(filtered, policy.agentControls)
  filtered = filterToolsForMode(policy.chatMode, filtered, toolIsReadOnly)
  filtered = filterToolsForPermissionMode(
    policy.permissionMode,
    filtered,
    toolIsReadOnly,
  ).tools

  const prepared = filtered.map((tool) => ({
    ...tool,
    input_schema: minimizeSchema(tool.input_schema),
  })) as T[]
  const kept = new Set(prepared.map((tool) => tool.name))
  return {
    tools: prepared,
    removed: originalNames.filter((name) => !kept.has(name)),
  }
}

type RankKey = [number, number, string]

/** Availability precedes G10 ranking so a denied candidate consumes no slot. */
export function shortlistAvailableToolDefinitions<T extends TurnToolDefinition>(
  tools: readonly T[],
  opts: {
    max: number
    isCatalogAvailable?: (name: string) => boolean
    /** Deterministic test seam; production uses the existing G10 ranker. */
    rank?: (name: string) => RankKey
  },
): { tools: T[]; refused: string[]; trimmed: string[] } {
  const available = tools.filter((tool) => (opts.isCatalogAvailable ?? isCatalogToolAvailable)(tool.name))
  const availableNames = new Set(available.map((tool) => tool.name))
  const refused = tools.filter((tool) => !availableNames.has(tool.name)).map((tool) => tool.name)
  if (opts.max <= 0) {
    return { tools: [], refused, trimmed: available.map((tool) => tool.name) }
  }
  let chosenNames: string[]
  if (opts.rank) {
    chosenNames = [...available]
      .sort((a, b) => {
        const ka = opts.rank!(a.name)
        const kb = opts.rank!(b.name)
        return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2])
      })
      .slice(0, Math.max(0, opts.max))
      .map((tool) => tool.name)
  } else {
    chosenNames = selectShortlist(available.map((tool) => tool.name), opts.max).toolNames
  }
  const chosen = new Set(chosenNames)
  const byName = new Map(available.map((tool) => [tool.name, tool]))
  return {
    tools: chosenNames.map((name) => byName.get(name)).filter((tool): tool is T => Boolean(tool)),
    refused,
    trimmed: available.filter((tool) => !chosen.has(tool.name)).map((tool) => tool.name),
  }
}

/**
 * Existing semantic router → actual group tools → G09/G08 filter → G10 bound.
 * This is a fail-open fallback only; keyword discovery remains the fast path.
 */
export async function semanticFallbackToolDefinitions(
  text: string,
  opts: {
    max: number
    semanticGroups?: (text: string) => Promise<string[]>
    toolsForGroups?: (groups: string[]) => Promise<TurnToolDefinition[]>
    isCatalogAvailable?: (name: string) => boolean
  },
): Promise<{ tools: TurnToolDefinition[]; refused: string[]; trimmed: string[] }> {
  const resolveGroups = opts.semanticGroups
    ?? (async (query: string) => {
      const semantic = await import('@/agent/tools/semantic-router')
      return semantic.semanticGroups(query)
    })
  const groups = await resolveGroups(text)
  if (groups.length === 0) return { tools: [], refused: [], trimmed: [] }

  const resolveGroupTools = opts.toolsForGroups
    ?? (async (selected: string[]) => {
      const { TOOL_GROUPS } = await import('@/agent/tools/tool-groups')
      const seen = new Set<string>()
      const tools: TurnToolDefinition[] = []
      for (const group of selected) {
        const members = TOOL_GROUPS[group as keyof typeof TOOL_GROUPS] ?? []
        for (const tool of members) {
          if (seen.has(tool.name)) continue
          seen.add(tool.name)
          tools.push(tool as TurnToolDefinition)
        }
      }
      return tools
    })
  const candidates = await resolveGroupTools(groups)
  const result = shortlistAvailableToolDefinitions(candidates, {
    max: opts.max,
    isCatalogAvailable: opts.isCatalogAvailable,
  })
  return {
    ...result,
    tools: result.tools.map((tool) => ({
      ...tool,
      input_schema: minimizeSchema(tool.input_schema),
    })),
  }
}
