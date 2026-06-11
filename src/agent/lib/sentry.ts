/**
 * Agent-scoped Sentry capture — tagged `agent` to separate from ERP noise.
 */
import { captureException, captureStructuredEvent } from '@/lib/sentry/capture'

export type AgentSentryContext = {
  route?: string
  tool?: string
  scheduler?: string
  conversationId?: string
  requestId?: string
}

export async function captureAgentError(
  err: unknown,
  event: string,
  context: AgentSentryContext = {},
): Promise<void> {
  const meta: Record<string, unknown> = {
    module: 'agent',
    ...context,
  }
  if (err instanceof Error && 'request_id' in err) {
    meta.requestId = (err as Error & { request_id?: string }).request_id
  }
  await captureStructuredEvent('error', event, meta)
  if (err instanceof Error) {
    await captureException(err, {
      category: 'agent',
      event,
      extra: { module: 'agent', ...context },
    })
  }
}

export async function captureAgentEvent(
  level: 'error' | 'warn' | 'info',
  event: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await captureStructuredEvent(level, event, { module: 'agent', ...meta })
}
