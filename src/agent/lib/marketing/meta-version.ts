/**
 * Phase 63 — the canonical Meta Graph version resolver now lives in the ERP
 * shared layer (`src/lib/meta-version.ts`) so ERP code can use it without
 * breaking the one-way dependency rule (ERP must not import `src/agent`). This
 * file re-exports it for existing agent-side importers — no behaviour change.
 */
export {
  META_GRAPH_DEFAULT_VERSION,
  metaGraphVersion,
  metaGraphBase,
  classifyMetaError,
} from '@/lib/meta-version'
export type { MetaErrorKind, MetaErrorClassification } from '@/lib/meta-version'
