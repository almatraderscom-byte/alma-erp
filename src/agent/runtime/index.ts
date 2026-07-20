/**
 * Head-isolation runtime barrel (G17).
 *
 * The runtime half of "no frontier head model as a default": de-escalation after
 * planning (SPEC-167), the frontier-head planner-only contract (SPEC-168), the
 * head-model tool-loop prohibition (SPEC-169), and the routing/head-isolation
 * regression gate (SPEC-170). Imports G16 tiers + G17 routing; no provider call.
 */
export * from './de-escalation';
export * from './head-planner';
