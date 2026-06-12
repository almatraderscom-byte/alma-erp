#!/usr/bin/env node
/**
 * Register Meta app-level webhook + subscribe both pages.
 * Requires: META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, FB_PAGE_TOKEN_*
 */
import 'dotenv/config'

const APP_ID = '1990978398451639'
const CALLBACK = 'https://alma-erp-six.vercel.app/api/assistant/internal/messenger-webhook'
const PAGES = [
  { id: '1044848232034171', token: process.env.FB_PAGE_TOKEN_LIFESTYLE },
  { id: '827260860637393', token: process.env.FB_PAGE_TOKEN_ONLINESHOP },
]

const secret = process.env.META_APP_SECRET
const verify = process.env.META_WEBHOOK_VERIFY_TOKEN

if (!secret || !verify) {
  console.error('META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN required')
  process.exit(1)
}

const appToken = `${APP_ID}|${secret}`

async function main() {
  console.log('[meta-webhook] registering app subscription...')
  const subRes = await fetch(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      object: 'page',
      callback_url: CALLBACK,
      verify_token: verify,
      fields: 'messages,messaging_postbacks,messaging_optins',
      access_token: appToken,
    }),
  })
  const sub = await subRes.json()
  console.log('[meta-webhook] app subscription:', JSON.stringify(sub))

  for (const page of PAGES) {
    if (!page.token) {
      console.warn(`[meta-webhook] skip page ${page.id} — no token`)
      continue
    }
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${page.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_optins&access_token=${page.token}`,
      { method: 'POST' },
    )
    const data = await res.json()
    console.log(`[meta-webhook] page ${page.id}:`, JSON.stringify(data))
  }

  const testUrl = `${CALLBACK}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verify)}&hub.challenge=setup_ok`
  const test = await fetch(testUrl)
  const body = await test.text()
  console.log(`[meta-webhook] GET verify HTTP ${test.status}: ${body.slice(0, 80)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
