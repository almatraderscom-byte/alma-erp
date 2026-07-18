export const OFFICE_CALL_RELEASE_PAIRS: string[]
export const OFFICE_CALL_RELEASE_SCENARIOS: string[]
export const OFFICE_CALL_ROW_ASSERTIONS: string[]
export function expectedOfficeCallMatrixKeys(): string[]
export function createOfficeCallReleaseTemplate(): Record<string, any>
export function evaluateOfficeCallReleaseEvidence(evidence: Record<string, any>): {
  pass: boolean
  expectedMatrixRows: number
  suppliedMatrixRows: number
  soakCalls: number
  reasons: string[]
}

