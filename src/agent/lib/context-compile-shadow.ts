/**
 * Context-compiler shadow cutover (audit P1-1, stage: shadow).
 *
 * The owner turn's prompt is already assembled deterministically
 * (system-prompt.ts stable/volatile blocks). This module runs the SPEC-041
 * context compiler over those SAME segments as a shadow: it produces the
 * typed provenance record + token accounting + budget verdicts and logs them
 * into the per-turn span spine (`route.context_compile`), WITHOUT touching
 * what the model actually receives. Once shadow data soaks, the flag ladder
 * ('warn' → 'enforce') can make the compiled output authoritative — exactly
 * the audit's off → shadow → warn → enforce migration pattern.
 *
 * Flag: AGENT_CONTEXT_COMPILER = off | shadow (default shadow).
 * Budgets (audit P1-1): stable core ≤ 5,000 tokens; initial head request
 * ≤ 15,000 tokens — breaches are RECORDED here, not yet enforced.
 */
import { compile, type ContextBundle, type CompiledContext } from '@/agent/context/compiler'

export const STABLE_CORE_TOKEN_BUDGET = 5_000
export const INITIAL_REQUEST_TOKEN_BUDGET = 15_000

export type ContextCompilerMode = 'off' | 'shadow'

export function contextCompilerMode(): ContextCompilerMode {
  const v = (process.env.AGENT_CONTEXT_COMPILER ?? '').trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false' ? 'off' : 'shadow'
}

export interface ShadowCompileResult {
  compiled: CompiledContext
  stableTokens: number
  initialRequestTokens: number
  stableWithinBudget: boolean
  initialWithinBudget: boolean
}

/**
 * Compile the owner turn's real segments through the SPEC-041 compiler.
 * Pure — deterministic given the same inputs.
 */
export function shadowCompileOwnerContext(opts: {
  /** stable system blocks in order (constitution/persona first) */
  stableBlocks: string[]
  /** per-turn volatile context (workflow state, scoped memory, snapshots) */
  volatileText: string
  /** the latest owner request text */
  requestText: string
}): ShadowCompileResult {
  const bundles: ContextBundle[] = []
  opts.stableBlocks.forEach((content, i) => {
    if (!content.trim()) return
    bundles.push({
      id: `stable-${i}`,
      // First stable block is the constitution/persona; the rest are the
      // skill/policy layers of the stable prefix.
      kind: i === 0 ? 'constitution' : 'skill',
      content,
      cacheable: true,
    })
  })
  if (opts.volatileText.trim()) {
    bundles.push({ id: 'volatile', kind: 'workflow_state', content: opts.volatileText, cacheable: false })
  }
  if (opts.requestText.trim()) {
    bundles.push({ id: 'request', kind: 'request_suffix', content: opts.requestText, cacheable: false })
  }

  const compiled = compile(bundles)
  const stableTokens = compiled.cacheablePrefixTokens
  const initialRequestTokens = compiled.totalTokens
  return {
    compiled,
    stableTokens,
    initialRequestTokens,
    stableWithinBudget: stableTokens <= STABLE_CORE_TOKEN_BUDGET,
    initialWithinBudget: initialRequestTokens <= INITIAL_REQUEST_TOKEN_BUDGET,
  }
}
