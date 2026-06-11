/**
 * Meta token pre-flight checker.
 * Run BEFORE enabling Facebook posting features.
 *
 * Usage:
 *   FB_PAGE_TOKEN_LIFESTYLE=<token> node worker/scripts/check-fb-token.mjs
 *   # or with dotenv:
 *   node -r dotenv/config worker/scripts/check-fb-token.mjs
 */

import 'dotenv/config'

const REQUIRED_SCOPES = ['pages_manage_posts', 'pages_read_engagement']

const PAGE_TOKENS = {
  'Alma Lifestyle (1044848232034171)': {
    token: process.env.FB_PAGE_TOKEN_LIFESTYLE,
    pageId: '1044848232034171',
  },
  'Alma Online Shop (827260860637393)': {
    token: process.env.FB_PAGE_TOKEN_ONLINESHOP,
    pageId: '827260860637393',
  },
}

async function checkToken(label, { token, pageId }) {
  if (!token) {
    console.log(`\n[${label}] ❌ Token not set in env`)
    return
  }

  console.log(`\n[${label}]`)

  // debug_token — only works with app access token or the token itself
  try {
    const debugRes = await fetch(
      `https://graph.facebook.com/v21.0/debug_token?input_token=${token}&access_token=${token}`,
    )
    const debug = await debugRes.json()

    if (debug.error) {
      console.log(`  debug_token error: ${debug.error.message}`)
    } else {
      const d = debug.data ?? {}
      const scopes = d.scopes ?? []
      const missingScopes = REQUIRED_SCOPES.filter((s) => !scopes.includes(s))
      console.log(`  App ID     : ${d.app_id ?? 'unknown'}`)
      console.log(`  Type       : ${d.type ?? 'unknown'}`)
      console.log(`  Valid      : ${d.is_valid ? '✓' : '✗'}`)
      console.log(`  Expires at : ${d.expires_at ? new Date(d.expires_at * 1000).toLocaleString() : 'never (page token)'}`)
      console.log(`  Scopes     : ${scopes.join(', ') || 'none'}`)
      if (missingScopes.length > 0) {
        console.log(`  ❌ Missing required scopes: ${missingScopes.join(', ')}`)
      } else {
        console.log(`  ✅ All required scopes present`)
      }
    }
  } catch (err) {
    console.log(`  debug_token request failed: ${err.message}`)
  }

  // /me/accounts — verify this token can see the page
  try {
    const accsRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?access_token=${token}`,
    )
    const accs = await accsRes.json()
    if (accs.error) {
      console.log(`  /me/accounts error: ${accs.error.message}`)
    } else {
      const pages = accs.data ?? []
      const match = pages.find((p) => p.id === pageId)
      if (match) {
        console.log(`  ✅ Page "${match.name}" (${match.id}) accessible`)
      } else {
        console.log(`  ⚠️  Page ${pageId} not found in /me/accounts (${pages.length} pages returned)`)
        pages.forEach((p) => console.log(`     - ${p.name} (${p.id})`))
      }
    }
  } catch (err) {
    console.log(`  /me/accounts request failed: ${err.message}`)
  }
}

console.log('=== ALMA ERP — Facebook Token Pre-flight Check ===')
console.log('Graph API version: v21.0\n')

for (const [label, cfg] of Object.entries(PAGE_TOKENS)) {
  await checkToken(label, cfg)
}

console.log('\n=== Done ===')
console.log('Required scopes: pages_manage_posts, pages_read_engagement')
console.log('If any token is expired or missing scopes, regenerate it in Meta Business Suite.')
