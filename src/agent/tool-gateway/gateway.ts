/**
 * G13 — Central Secure Tool Gateway (assembled pipeline).
 *
 * The ordered, fail-closed stage pipeline every external tool side-effect runs
 * through. The array grows one stage per G13 spec (SPEC-122..129), in the exact
 * order the architecture mandates:
 *   schema → identity → policy → cost → approval/obligation → execution →
 *   evidence → audit/finalization.
 *
 * Deterministic (INV-01): the gateway composes pure stages; provider/network calls
 * live only behind the execution adapter seam.
 */
import type { GatewayStage } from './contract'
import { schemaValidationStage } from './stages/schema-validation'
import { identityValidationStage } from './stages/identity-validation'
import { policyDecisionStage } from './stages/policy-decision'
import { costAuthorizationStage } from './stages/cost-authorization'
import { approvalObligationStage } from './stages/approval-obligation'
import { executionAdapterStage } from './stages/execution-adapter'
import { evidenceCaptureStage } from './stages/evidence-capture'

/** The default production stage order. Grows as each stage spec lands. */
export const DEFAULT_STAGES: readonly GatewayStage[] = [
  schemaValidationStage, // SPEC-122
  identityValidationStage, // SPEC-123
  policyDecisionStage, // SPEC-124
  costAuthorizationStage, // SPEC-125
  approvalObligationStage, // SPEC-126
  executionAdapterStage, // SPEC-127
  evidenceCaptureStage, // SPEC-128
]
