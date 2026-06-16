# Cloudflare Telegram Bot API Proxy — 5-minute setup

## Why this exists

The VPS (Hostinger 31.97.237.40) is being **deep-packet-inspected** by upstream
network and `https://api.telegram.org` is fully blocked at the TLS layer.
The Telegram bot cannot poll updates or send messages.

This document gives you a **free Cloudflare Worker** that proxies the Telegram
Bot API. Once deployed, the VPS will route all Telegram traffic through
Cloudflare (which is not blocked) and the bot recovers.

## What you do (5 minutes, one-time)

### 1. Create the Cloudflare Worker

1. Open https://dash.cloudflare.com (you already have an account for almatraders.com)
2. Left sidebar → **Workers & Pages** → **Create application** → **Create Worker**
3. Name: `tg-proxy` (or anything you like)
4. Click **Deploy** (the default "Hello World" worker)
5. Click **Edit code** on the deployed worker
6. **Replace the entire `worker.js` file** with the code below:

```javascript
// ALMA ERP — Telegram Bot API proxy (Cloudflare Worker)
// Forwards every request 1:1 to https://api.telegram.org

export default {
  async fetch(request) {
    const url = new URL(request.url)

    // Build the upstream URL: replace our worker hostname with api.telegram.org
    const upstream = new URL(url.pathname + url.search, 'https://api.telegram.org')

    // Forward the request, preserving method, headers, and body
    const init = {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow',
    }

    try {
      const upstreamRes = await fetch(upstream.toString(), init)
      // Stream the response back unchanged
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: upstreamRes.headers,
      })
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: 'proxy_upstream_error', detail: String(err) }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    }
  },
}
```

7. Click **Save and deploy**
8. Copy the worker URL — it will be something like:
   `https://tg-proxy.<your-subdomain>.workers.dev`
9. **Test it works** in your browser: open `https://tg-proxy.<your-subdomain>.workers.dev`
   You should see a JSON response like:
   ```json
   {"ok":false,"error_code":404,"description":"Not Found"}
   ```
   (404 is expected — that's Telegram's own response to a missing path; it proves
   the proxy is reaching Telegram.)

### 2. Tell the VPS to use the proxy

Send me the worker URL, OR run this yourself:

```bash
ssh root@31.97.237.40
echo 'TELEGRAM_API_BASE=https://tg-proxy.YOUR-SUBDOMAIN.workers.dev' >> /opt/alma-erp/worker/.env
pm2 restart agent-worker --update-env
sleep 5
pm2 logs agent-worker --lines 30 --nostream | tail -30
```

You should see in the logs:
```
[telegram-proxy] redirecting https://api.telegram.org → https://tg-proxy.YOUR-SUBDOMAIN.workers.dev
[telegram] Bot initializing...
[telegram] @your_bot_username online
```

### 3. Verify

Send `/start` to your assistant Telegram bot. It should respond within 2 seconds.

## Why this is safe

- Cloudflare Workers run on a different network than your VPS — no upstream block
- The bot token never leaves your VPS in plaintext beyond the Cloudflare TLS pipe
- Cloudflare doesn't log request bodies by default
- The worker is read-only proxy — no logic, no token storage

## Cost

- Cloudflare Workers free plan: **100,000 requests/day**
- Your bot does ~5,000 requests/day at peak (heartbeats, polls, sends)
- You will not exceed free tier

## When you no longer need the proxy

If Hostinger ever unblocks Telegram, just remove the env var:
```bash
ssh root@31.97.237.40
sed -i '/TELEGRAM_API_BASE/d' /opt/alma-erp/worker/.env
pm2 restart agent-worker --update-env
```
The worker auto-detects no proxy is set and goes back to direct mode.
