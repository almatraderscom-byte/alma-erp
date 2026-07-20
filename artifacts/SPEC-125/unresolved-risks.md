# SPEC-125 — Unresolved risks
1. estimatedCostNanoUsd is caller-supplied (worst-case); the finalization stage
   reconciles to actual. A caller under-estimating is bounded by the reservation
   (commit clamps to reserved). Severity: low. Critical: 0.
