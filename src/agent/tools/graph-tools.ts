import type { AgentTool } from './registry'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import { recordEdge, getEntityNeighborhood } from '@/agent/lib/knowledge-graph'

function resolveBusinessId(input: Record<string, unknown>): AgentBusinessId {
  return input.businessId === 'ALMA_TRADING' ? 'ALMA_TRADING' : 'ALMA_LIFESTYLE'
}

const graph_remember: AgentTool = {
  name: 'graph_remember',
  description:
    'Records ONE relationship between two business entities into graph-memory (subject -predicate-> object). Use when you learn how two things connect — e.g. a customer placed an order, an order was handled by a staff member, a customer prefers a product, a product is often returned for sizing. This is for CONNECTIONS between entities; use save_memory for a standalone fact. Entity types: customer, order, staff, product, topic. Labels should be the natural name/id (e.g. "Nusrat Jahan", "AL-0310", "Rakib", "Navy Blue Punjabi"). Business scope is auto-tagged from server context.',
  input_schema: {
    type: 'object' as const,
    properties: {
      subjectType: { type: 'string', enum: ['customer', 'order', 'staff', 'product', 'topic'], description: 'Type of the subject entity' },
      subjectLabel: { type: 'string', description: 'Natural name/id of the subject (e.g. "Nusrat Jahan", "AL-0310")' },
      predicate: { type: 'string', description: 'The relationship, short verb phrase (e.g. "placed", "handled_by", "prefers", "returned", "related_to")' },
      objectType: { type: 'string', enum: ['customer', 'order', 'staff', 'product', 'topic'], description: 'Type of the object entity' },
      objectLabel: { type: 'string', description: 'Natural name/id of the object' },
      note: { type: 'string', description: 'Optional short context for this relationship (e.g. "13 days pending COD")' },
    },
    required: ['subjectType', 'subjectLabel', 'predicate', 'objectType', 'objectLabel'],
  },
  handler: async (input) => {
    const subjectLabel = String(input.subjectLabel ?? '').trim()
    const objectLabel = String(input.objectLabel ?? '').trim()
    const predicate = String(input.predicate ?? '').trim()
    const subjectType = String(input.subjectType ?? '').trim()
    const objectType = String(input.objectType ?? '').trim()
    if (!subjectLabel || !objectLabel || !predicate || !subjectType || !objectType) {
      return { success: false, error: 'subjectType, subjectLabel, predicate, objectType, objectLabel are all required' }
    }
    try {
      const edge = await recordEdge({
        subjectType, subjectLabel,
        predicate,
        objectType, objectLabel,
        note: input.note ? String(input.note) : null,
        businessId: resolveBusinessId(input),
      })
      return {
        success: true,
        data: {
          id: edge.id,
          relationship: `${edge.subjectLabel} → ${edge.predicate} → ${edge.objectLabel}`,
          weight: edge.weight,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const graph_recall: AgentTool = {
  name: 'graph_recall',
  description:
    'Recalls everything connected to ONE business entity by traversing graph-memory — e.g. "what do I know about customer X", "what is connected to order AL-0310". Returns the relationship neighborhood (who/what links to this entity). Use this for entity-centric recall; use search_memory for free-text semantic recall. Combine both when answering a broad "tell me about X" question.',
  input_schema: {
    type: 'object' as const,
    properties: {
      label: { type: 'string', description: 'Natural name/id of the entity to look up (e.g. "Nusrat Jahan", "AL-0310")' },
      type: { type: 'string', enum: ['customer', 'order', 'staff', 'product', 'topic'], description: 'Optional entity type filter' },
      hops: { type: 'number', description: 'Traversal depth: 1 = direct connections (default), 2 = also connections of neighbors' },
    },
    required: ['label'],
  },
  handler: async (input) => {
    const label = String(input.label ?? '').trim()
    if (!label) return { success: false, error: 'label is empty' }
    try {
      const result = await getEntityNeighborhood({
        label,
        type: input.type ? String(input.type) : null,
        hops: input.hops != null ? Number(input.hops) : 1,
        businessId: resolveBusinessId(input),
      })
      return {
        success: true,
        data: {
          entity: result.entity,
          count: result.edges.length,
          connections: result.lines,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const GRAPH_TOOLS: AgentTool[] = [graph_remember, graph_recall]
