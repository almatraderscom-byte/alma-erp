import type { AgentTool } from './registry'
import {
  researchCompetitorCreatives,
  getTopReferences,
  listReferenceLibrary,
  pruneReference,
} from '@/agent/lib/reference/library'

const research_competitor_creatives: AgentTool = {
  name: 'research_competitor_creatives',
  description:
    'Search Meta Ad Library (Bangladesh) for active fashion/panjabi competitor ads. ' +
    'Vision-extracts composition/lighting/mood attrs + why-it-works (pattern only — never clone branding). ' +
    'Stores source:competitor rows in the reference library. Owner-triggered on-demand.',
  input_schema: {
    type: 'object' as const,
    properties: {
      keyword: { type: 'string', description: 'Search term e.g. panjabi, ethnic wear' },
      brand: { type: 'string', description: 'Optional competitor page/brand name to narrow search' },
      productType: { type: 'string', description: 'Product type tag e.g. panjabi, family_set' },
      limit: { type: 'number', description: 'Max ads to process (1-10, default 6)' },
    },
  },
  handler: async (input) => {
    try {
      const result = await researchCompetitorCreatives({
        keyword: input.keyword ? String(input.keyword) : undefined,
        brand: input.brand ? String(input.brand) : undefined,
        productType: input.productType ? String(input.productType) : undefined,
        limit: input.limit != null ? Number(input.limit) : undefined,
      })
      if (result.error && !result.stored) {
        return {
          success: false,
          error: result.error,
          data: { scopeGap: result.scopeGap, searched: result.searched },
        }
      }
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const list_reference_library: AgentTool = {
  name: 'list_reference_library',
  description:
    'Show stored creative references (competitor, own_winner) ranked by score. ' +
    'Day-1 seeds come from File 14 design playbook — not duplicated here.',
  input_schema: {
    type: 'object' as const,
    properties: {
      source: { type: 'string', enum: ['competitor', 'own_winner', 'seed'], description: 'Filter by where the reference came from' },
      productType: { type: 'string', description: 'Filter by product type, e.g. panjabi' },
      limit: { type: 'number', description: 'Max results to return' },
    },
  },
  handler: async (input) => {
    const refs = await listReferenceLibrary({
      source: input.source ? String(input.source) : undefined,
      productType: input.productType ? String(input.productType) : undefined,
      limit: input.limit != null ? Number(input.limit) : undefined,
    })
    return {
      success: true,
      data: {
        count: refs.length,
        references: refs,
        message: refs.length
          ? `${refs.length}টি reference — generation-এ top refs auto-feed হয়।`
          : 'Library খালি — research_competitor_creatives চালান; seeds File 14 playbook থেকে আসে।',
      },
    }
  },
}

const forget_reference: AgentTool = {
  name: 'forget_reference',
  description: 'Remove a weak reference from the library (by id from list_reference_library).',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Reference id from list_reference_library' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const id = String(input.id ?? '').trim()
    if (!id.startsWith('playbook:')) {
      const ok = await pruneReference(id)
      if (!ok) return { success: false, error: 'reference not found' }
      return { success: true, data: { id, message: 'Reference removed.' } }
    }
    return { success: false, error: 'Playbook seeds cannot be deleted here — use forget_rule for owner rules.' }
  },
}

export const REFERENCE_TOOLS: AgentTool[] = [
  research_competitor_creatives,
  list_reference_library,
  forget_reference,
]

export const REFERENCE_ROLE_PROMPT = `
## REFERENCE LIBRARY (File 15)
research_competitor_creatives: Meta Ad Library BD search → pattern attrs (NOT clone competitor branding).
list_reference_library / forget_reference: curate stored refs.
Generation auto-uses getTopReferences — own_winner > competitor > File 14 playbook seeds.
`

export { getTopReferences }
