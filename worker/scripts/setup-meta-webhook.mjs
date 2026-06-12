#!/usr/bin/env node
/**
 * Register Meta app-level webhook + subscribe pages to the CORRECT app only.
 *
 * Requires: META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, FB_PAGE_TOKEN_*
 *
 * Page access tokens MUST be issued by META_APP_ID (see Meta → Graph API Explorer).
 * Wrong-app tokens re-subscribe a duplicate app and webhooks never reach Vercel.
 */
import 'dotenv/config'

const META_APP_ID = process.env.META_APP_ID ?? '1990978398451639'
/** Legacy duplicate app — must not stay subscribed on production pages */
const WRONG_APP_IDS = (process.env.META_WRONG_APP_IDS ?? '1561833048688297')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const CALLBACK = 'https://alma-erp-six.vercel.app/api/assistant/internal/messenger-webhook'
const FIELDS = 'messages,messaging_postbacks,messaging_optins,feed'

const PAGES = [
  { id: '1044848232034171', name: 'Alma Lifestyle', token: process.env.FB_PAGE_TOKEN_LIFESTYLE },
  { id: '827260860637393', name: 'Alma Online Shop', token: process.env.FB_PAGE_TOKEN_ONLINESHOP },
]

const secret = process.env.META_APP_SECRET
const verify = process.env.META_WEBHOOK_VERIFY_TOKEN

if (!secret || !verify) {
  console.error('META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN required')
  process.exit(1)
}

const appToken = `${META_APP_ID}|${secret}`

async function graphJson(url, opts = {}) {
  const res = await fetch(url, opts)
  const data = await res.json()
  return { res, data }
}

async function getSubscribedApps(pageId, pageToken) {
  const { data } = await graphJson(
    `https://graph.facebook.com/v21.0/${pageId}/subscribed_apps?access_token=${encodeURIComponent(pageToken)}`,
  )
  return data.data ?? []
}

async function unsubscribeWrongApps(pageId, pageToken) {
  for (const wrongId of WRONG_APP_IDS) {
    if (wrongId === META_APP_ID) continue
    const { data } = await graphJson(
      `https://graph.facebook.com/v21.0/${pageId}/subscribed_apps?app_id=${wrongId}&access_token=${encodeURIComponent(pageToken)}`,
      { method: 'DELETE' },
    )
    console.log(`[meta-webhook] unsubscribe ${wrongId} from ${pageId}:`, JSON.stringify(data))
  }
}

async function subscribePage(pageId, pageToken) {
  const { data } = await graphJson(
    `https://graph.facebook.com/v21.0/${pageId}/subscribed_apps?subscribed_fields=${FIELDS}&access_token=${encodeURIComponent(pageToken)}`,
    { method: 'POST' },
  )
  return data
}

async function verifyPageApp(page, subscribed) {
  const ids = subscribed.map((a) => a.id)
  if (!ids.includes(META_APP_ID)) {
    console.error(
      `[meta-webhook] FAIL ${page.name} (${page.id}): not subscribed to app ${META_APP_ID}.`,
      `Subscribed: [${ids.join(', ')}].`,
      'Page token was issued by a different Meta app.',
      `Fix: Meta Developers → App ${META_APP_ID} → Graph API Explorer →`,
      'User token (pages_messaging, pages_manage_metadata) →',
      `GET /${page.id}?fields=access_token → update FB_PAGE_TOKEN in Vercel + VPS.`,
    )
    return false
  }
  const wrong = ids.filter((id) => WRONG_APP_IDS.includes(id))
  if (wrong.length) {
    console.error(`[meta-webhook] FAIL ${page.name}: still subscribed to wrong app(s): ${wrong.join(', ')}`)
    return false
  }
  console.log(`[meta-webhook] OK ${page.name} → app ${META_APP_ID}`)
  return true
}

async function main() {
  console.log(`[meta-webhook] target app ${META_APP_ID}, callback ${CALLBACK}`)

  console.log('[meta-webhook] registering app-level webhook subscription...')
  const { data: sub } = await graphJson(`https://graph.facebook.com/v21.0/${META_APP_ID}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      object: 'page',
      callback_url: CALLBACK,
      verify_token: verify,
      fields: FIELDS,
      access_token: appToken,
    }),
  })
  console.log('[meta-webhook] app subscription:', JSON.stringify(sub))

  let allOk = true

  for (const page of PAGES) {
    if (!page.token) {
      console.warn(`[meta-webhook] skip ${page.name} — no page token`)
      continue
    }

    await unsubscribeWrongApps(page.id, page.token)
    const subResult = await subscribePage(page.id, page.token)
    console.log(`[meta-webhook] subscribe ${page.name}:`, JSON.stringify(subResult))

    const subscribed = await getSubscribedApps(page.id, page.token)
    if (!(await verifyPageApp(page, subscribed))) allOk = false
  }

  const testUrl = `${CALLBACK}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verify)}&hub.challenge=setup_ok`
  const test = await fetch(testUrl)
  const body = await test.text()
  console.log(`[meta-webhook] GET verify HTTP ${test.status}: ${body.slice(0, 80)}`)

  if (!allOk) {
    console.error('[meta-webhook] SETUP INCOMPLETE — fix page tokens (see errors above) and re-run.')
    process.exit(1)
  }
  console.log('[meta-webhook] SETUP OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
