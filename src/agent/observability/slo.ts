/**
 * Agent operational SLOs (G20 / SPEC-192).
 *
 * Declares the service-level objectives the agent is held to — success rate,
 * p95 latency, cost-per-success — and evaluates a measurement window against them,
 * reporting which objectives are MET or BREACHED. Deterministic (INV-01). Money is
 * integer nano-USD.
 */
export interface Slo {
  id: string;
  minSuccessRate: number;   // 0..1
  maxP95LatencyMs: number;
  maxCostPerSuccessNanoUsd: number;
}

export interface SloWindow {
  total: number;
  succeeded: number;
  p95LatencyMs: number;
  costPerSuccessNanoUsd: number;
}

export interface SloEvaluation {
  ok: boolean;
  successRate: number;
  breaches: string[];
}

export const DEFAULT_AGENT_SLO: Slo = {
  id: 'agent.default',
  minSuccessRate: 0.95,
  maxP95LatencyMs: 30_000,
  maxCostPerSuccessNanoUsd: 500_000_000, // 0.5 USD
};

export function evaluateSlo(slo: Slo, w: SloWindow): SloEvaluation {
  const breaches: string[] = [];
  const successRate = w.total === 0 ? 0 : w.succeeded / w.total;
  if (w.total === 0) breaches.push('no_data');
  if (successRate < slo.minSuccessRate) breaches.push('success_rate');
  if (w.p95LatencyMs > slo.maxP95LatencyMs) breaches.push('p95_latency');
  if (w.costPerSuccessNanoUsd > slo.maxCostPerSuccessNanoUsd) breaches.push('cost_per_success');
  return { ok: breaches.length === 0, successRate, breaches };
}
