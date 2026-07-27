/**
 * GET    /api/assistant/phone-console/settings/provider        — is a credential stored, and
 *        …?check=1                                               what does their table say
 * PUT    same — store the credential (the owner types it; it is encrypted and never returned)
 * DELETE same — forget it
 *
 * Owner-only. The password never appears in a GET response, in a log line, or in any payload
 * that leaves this process for anywhere except the provider's own host.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { requireConsoleOwner } from '@/agent/lib/phone-console-guard'
import {
  deleteProviderCredential,
  providerEncryptionConfigured,
  providerState,
  providerUrls,
  saveProviderCredential,
} from '@/agent/lib/phone-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Their panel can be slow, and a login round-trip on top of it needs room.
export const maxDuration = 45

export async function GET(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const check = new URL(req.url).searchParams.get('check') === '1'
  const [state, urls] = await Promise.all([providerState(check), providerUrls()])
  return NextResponse.json({ ok: true, provider: state, urls, encryptionReady: providerEncryptionConfigured() })
}

export async function PUT(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const body = (await req.json().catch(() => ({}))) as {
    username?: string
    secret?: string
    loginUrl?: string
    statusUrl?: string
  }

  const result = await saveProviderCredential({
    username: String(body.username ?? ''),
    secret: String(body.secret ?? ''),
    loginUrl: body.loginUrl,
    statusUrl: body.statusUrl,
  })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 })

  // Save then immediately check, so a wrong password is caught while he is still on the page.
  const state = await providerState(true)
  return NextResponse.json({ ok: true, provider: state })
}

export async function DELETE() {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response
  await deleteProviderCredential()
  return NextResponse.json({ ok: true })
}
