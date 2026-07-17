import { type NextRequest } from 'next/server'
import { checkBotId } from 'botid/server'
import { captureAgentEvent } from '@/agent/lib/sentry'

type BotIdHeaders = Record<string, string>

function requestHeaders(req: NextRequest): BotIdHeaders {
  const out: BotIdHeaders = {}
  req.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  out['x-method'] = req.method
  out['x-path'] = req.nextUrl.pathname
  out.url = req.url
  return out
}

export async function requireAssistantHumanRequest(
  req: NextRequest,
  opts: { route: string; bypass?: boolean },
): Promise<Response | null> {
  if (opts.bypass) return null

  try {
    const result = await checkBotId({
      developmentOptions: {
        isDevelopment: process.env.NODE_ENV !== 'production' || process.env.VERCEL_ENV !== 'production',
        bypass: 'HUMAN',
      },
      advancedOptions: {
        checkLevel: 'basic',
        headers: requestHeaders(req),
      },
    })

    if (result.isBot) {
      void captureAgentEvent('warn', 'agent.botid.blocked', { route: opts.route })
      return Response.json({ error: 'bot_detected' }, { status: 403 })
    }
  } catch (err) {
    // Fail open: BotID is a protection layer, but a misconfigured OIDC/proxy
    // should not take the owner agent offline. The event keeps the gap visible.
    void captureAgentEvent('warn', 'agent.botid.check_failed', {
      route: opts.route,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return null
}
