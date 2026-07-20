/**
 * End-to-end trace model (G20 / SPEC-191).
 *
 * One owner request touches many components — admission, cost governor, policy,
 * gateway, workflow, response gate. A trace stitches their spans together by the
 * shared correlationId so a run can be reconstructed and debugged. Pure assembly
 * over spans the components emit; deterministic, timestamps supplied on the spans
 * (INV-01, no clock here).
 */
import { z } from 'zod';

export type SpanStatus = 'ok' | 'denied' | 'failed' | 'needs_approval';

export interface Span {
  spanId: string;
  component: string;
  correlationId: string;
  status: SpanStatus;
  startMs: number;
  endMs: number;
  reasonCodes?: string[];
}

export interface Trace {
  correlationId: string;
  spans: Span[];
  startMs: number;
  endMs: number;
  durationMs: number;
  status: SpanStatus;
  componentPath: string[];
}

export const TRACE_REASON_CODES = {
  MIXED_CORRELATION: 'TRACE_MIXED_CORRELATION',
  EMPTY: 'TRACE_EMPTY',
  MALFORMED_SPAN: 'TRACE_MALFORMED_SPAN',
} as const;

const spanSchema = z.object({
  spanId: z.string().min(1),
  component: z.string().min(1),
  correlationId: z.string().min(1),
  status: z.enum(['ok', 'denied', 'failed', 'needs_approval']),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  reasonCodes: z.array(z.string()).optional(),
});

/** Overall trace status: worst of its spans (failed > denied > needs_approval > ok). */
function rollupStatus(spans: Span[]): SpanStatus {
  if (spans.some((s) => s.status === 'failed')) return 'failed';
  if (spans.some((s) => s.status === 'denied')) return 'denied';
  if (spans.some((s) => s.status === 'needs_approval')) return 'needs_approval';
  return 'ok';
}

export type TraceResult = { ok: true; trace: Trace } | { ok: false; reasonCodes: string[] };

/** Assemble a trace from spans that share one correlationId. Fail-closed on mix/empty/malformed. */
export function buildTrace(correlationId: string, spans: Span[]): TraceResult {
  if (spans.length === 0) return { ok: false, reasonCodes: [TRACE_REASON_CODES.EMPTY] };
  if (spans.some((s) => !spanSchema.safeParse(s).success)) return { ok: false, reasonCodes: [TRACE_REASON_CODES.MALFORMED_SPAN] };
  if (spans.some((s) => s.correlationId !== correlationId)) return { ok: false, reasonCodes: [TRACE_REASON_CODES.MIXED_CORRELATION] };

  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs || a.spanId.localeCompare(b.spanId));
  const startMs = Math.min(...ordered.map((s) => s.startMs));
  const endMs = Math.max(...ordered.map((s) => s.endMs));
  return {
    ok: true,
    trace: {
      correlationId,
      spans: ordered,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      status: rollupStatus(ordered),
      componentPath: ordered.map((s) => s.component),
    },
  };
}
