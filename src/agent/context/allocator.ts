/**
 * Context token allocator (G05 / SPEC-049).
 *
 * Fits the compiled context inside a token budget. When the bundles exceed the
 * budget, the lowest-priority ones (memory first, then workflow-state, tool-schema,
 * skill) are dropped until it fits; the must-keep bundles (constitution, policy,
 * the user request) are never dropped. If even the must-keeps overflow, the
 * result is OVERFLOW (fail-closed — the caller must shrink, not silently proceed).
 * Deterministic, pure. Uses the G03 estimator via compile().
 */
import { compile, type BundleKind, type CompiledContext, type ContextBundle } from './compiler';
import { heuristicTokenEstimator, type TokenEstimator } from '../finops/tokens';

/** Dropped first → last when over budget. Must-keeps are never in this list. */
export const TRUNCATE_PRIORITY: BundleKind[] = ['memory', 'workflow_state', 'tool_schema', 'skill'];
export const MUST_KEEP: BundleKind[] = ['constitution', 'policy', 'request_suffix'];

export type AllocationStatus = 'FIT' | 'TRUNCATED' | 'OVERFLOW';

export interface AllocationResult {
  compiled: CompiledContext;
  status: AllocationStatus;
  droppedKinds: BundleKind[];
  maxTokens: number;
}

export function allocate(
  bundles: ContextBundle[],
  maxTokens: number,
  estimator: TokenEstimator = heuristicTokenEstimator,
): AllocationResult {
  let kept = [...bundles];
  const dropped: BundleKind[] = [];

  const total = () => compile(kept, estimator).totalTokens;

  for (const kind of TRUNCATE_PRIORITY) {
    if (total() <= maxTokens) break;
    if (kept.some((b) => b.kind === kind)) {
      kept = kept.filter((b) => b.kind !== kind);
      dropped.push(kind);
    }
  }

  const compiled = compile(kept, estimator);
  let status: AllocationStatus;
  if (compiled.totalTokens <= maxTokens) status = dropped.length === 0 ? 'FIT' : 'TRUNCATED';
  else status = 'OVERFLOW'; // even must-keeps exceed the budget

  return { compiled, status, droppedKinds: dropped, maxTokens };
}
