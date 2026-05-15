# Supplier product import (Smart China Hub)

## Architecture

1. **Local Playwright scraper** (`npm run supplier:scrape`) — **no automated login**. It attaches to **your already logged-in Chrome** over **CDP** (`--remote-debugging-port`), opens the seller products URL, and writes `tmp/supplier-products.json`.
2. **Alma ERP UI** — **Inventory → Import Supplier Products** — paste JSON, **preview** duplicates (within the file and against **PRODUCT MASTER**), map categories, **commit** in chunks via Next.js → Google Apps Script.

## Authenticated Chrome (CDP)

1. **Quit** all Chrome windows.
2. Start Chrome with remote debugging:
   - **macOS:**  
     `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222`
3. In that window, go to Smart China Hub and **log in manually** if needed (password, 2FA, captcha — all fine).
4. From the Alma repo directory run:
   ```bash
   SMARTCHINAHUB_CDP_URL=http://127.0.0.1:9222 npm run supplier:scrape
   ```
5. Paste `tmp/supplier-products.json` into the ERP importer.

The scraper opens a **new tab** in your browser; it inherits cookies from your logged-in session.

## Environment (`.env.local`)

```bash
NEXT_PUBLIC_API_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT/exec
API_SECRET=your-strong-secret-here

# Scraper — CDP only (Chrome must be started with --remote-debugging-port)
SMARTCHINAHUB_CDP_URL=http://127.0.0.1:9222

# SMARTCHINAHUB_PRODUCTS_URL=https://www.smartchinahub.com/seller/products/show
# SMARTCHINAHUB_NAV_TIMEOUT_MS=60000
# SMARTCHINAHUB_HYDRATION_MS=6000
```

**Do not** put supplier passwords in the repo. CDP reuses your interactive login.

## Debug screenshots

PNG files under **`tmp/debug-scraper/`** — each run overwrites:

- `connected-session.png` — first open tab (or tab after first navigation)
- `products-page.png` — products view before extraction
- `extraction-preview.png` — when product cards are detected (or when none matched, for debugging)

Additional timestamped screenshots may be written on errors.

## Google Sheet: PRODUCT MASTER

Same as before: tab **PRODUCT MASTER**, headers row **2**, deploy **`WebApp_API.gs.js`** with `products` + `batch_import_product_master` routes.

## Commands

```bash
npx playwright install chromium   # once
npm run supplier:scrape
```

## Selector maintenance

If the supplier HTML changes, edit **`SELECTORS.productRow`** and **`SELECTORS.nextPage`** in `scripts/smartchinahub-scraper.mjs`.
