/**
 * G13 / SPEC-130 — Direct external-call bypass gate (tested source).
 *
 * Mirrors G11's authorization-bypass gate: pure, dependency-free scan functions
 * that the CI runner (`check-gateway-bypass.mjs`) wraps. It enforces that every
 * external tool side-effect goes through the gateway's execution ADAPTER seam and
 * never a raw provider/network call in the gateway core.
 *
 * FALSE-POSITIVE-FREE by scoping:
 *  Rule A — gateway core purity: a file UNDER `src/agent/tool-gateway/` (excluding
 *    tests and the adapter stage, and any line marked `gateway-adapter-ok`) must
 *    NOT contain a direct network call (fetch/axios/WebSocket/http(s) client).
 *  Rule B — gateway-aware bypass: a file OUTSIDE the gateway that IMPORTS the
 *    gateway (routes a call through it) must not ALSO make a direct network call
 *    for that side-effect (marked `gateway-adapter-ok` to opt out after review).
 * The vast pre-existing agent code that neither lives in the gateway nor imports
 * it is OUT OF SCOPE — so legacy direct calls are never false-flagged.
 */

export const GATEWAY_PATH = 'src/agent/tool-gateway/'
/** The one file allowed to invoke the adapter seam (it calls adapter.execute, not the network). */
export const ADAPTER_STAGE = 'src/agent/tool-gateway/stages/execution-adapter.ts'
export const OPT_OUT = 'gateway-adapter-ok'

/** Direct provider/network call tokens. */
export const NETWORK_CALL_RE =
  /\bfetch\s*\(|\baxios\b|\bnew\s+WebSocket\s*\(|\bnode-fetch\b|\bhttps?\.request\s*\(|\bgot\s*\(|\bsuperagent\b/

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

export function isInsideGateway(file: string): boolean {
  return file.replace(/\\/g, '/').includes(GATEWAY_PATH)
}
export function isTestFile(file: string): boolean {
  const f = file.replace(/\\/g, '/')
  return f.includes('/__tests__/') || f.endsWith('.test.ts')
}
export function isAdapterStage(file: string): boolean {
  return file.replace(/\\/g, '/').endsWith(ADAPTER_STAGE)
}

/** Does the file import the gateway (route a side-effect through it)? */
export function importsGateway(imports: readonly string[]): boolean {
  return imports.some((spec) => /(?:^|\/)tool-gateway(?:\/|$)|@\/agent\/tool-gateway/.test(spec))
}

export function extractImports(src: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1] || m[2] || m[3]
    if (spec) out.push(spec)
  }
  return out
}

/** A network-call line that is neither a comment nor opt-out-marked. */
function offendingLines(src: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = []
  src.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (line.startsWith('*') || line.startsWith('//')) return // doc/comment
    if (line.includes(OPT_OUT)) return
    if (NETWORK_CALL_RE.test(line)) hits.push({ line: i + 1, text: line.slice(0, 80) })
  })
  return hits
}

export interface BypassViolation {
  file: string
  kind: 'gateway-core-network-call' | 'gateway-aware-bypass'
  line: number
  detail: string
}

/** Scan one file. Returns any violations (empty = clean). Pure. */
export function scanFileForBypass(file: string, src: string): BypassViolation[] {
  if (isTestFile(file)) return []
  const violations: BypassViolation[] = []

  // Rule A — gateway core purity (the adapter stage is the sanctioned seam invoker).
  if (isInsideGateway(file) && !isAdapterStage(file)) {
    for (const h of offendingLines(src)) {
      violations.push({ file, kind: 'gateway-core-network-call', line: h.line, detail: h.text })
    }
    return violations
  }

  // Rule B — a gateway-aware file that also bypasses with a direct call.
  if (!isInsideGateway(file) && importsGateway(extractImports(src))) {
    for (const h of offendingLines(src)) {
      violations.push({ file, kind: 'gateway-aware-bypass', line: h.line, detail: h.text })
    }
  }
  return violations
}
