/**
 * Measured routing barrel (G17).
 *
 * Task-class performance records (SPEC-161), cost-quality + latency-availability
 * scores (SPEC-162/163), the measured model router (SPEC-164), and the explicit
 * escalation reason + budget contracts (SPEC-165/166). Enforces the frozen
 * invariant: no frontier head model as a default route. Imports G03 cost
 * estimates and G16 model tiers/adapters; makes no real provider call.
 */
export * from './performance-records';
export * from './cost-quality-score';
export * from './latency-availability-score';
export * from './measured-router';
