# Alma Lifestyle ERP — Frontend

> Luxury fashion brand ERP system · Next.js 14 · TypeScript · Tailwind CSS · Framer Motion

## Quick Start

```bash
npm install
npm run dev
# → http://localhost:3000
```

## Connect to Google Sheets

1. Deploy `WebApp_API.gs` as a Google Apps Script Web App
2. Copy the deployment URL
3. Edit `.env.local`:

```
NEXT_PUBLIC_API_URL=https://script.google.com/macros/s/YOUR_ID/exec
API_SECRET=your-secret-here
```

4. Restart dev server — live data loads automatically

Without the URL, the app runs in **mock mode** with sample data from your real ERP structure.

## Pages

| Page | Route | Description |
|------|-------|-------------|
| Dashboard | `/` | KPIs, revenue chart, recent orders, SLA alerts |
| Orders | `/orders` | Full order table, status filters, detail drawer, status advance |
| CRM | `/crm` | Customer profiles, CLV scores, risk intelligence, segment filters |
| Inventory | `/inventory` | Stock table, utilisation bars, category filters |
| Analytics | `/analytics` | Revenue trends, expense breakdown, category performance |
| Invoice | `/invoice` | PDF invoice preview and generation, Drive sync |

## Architecture

```
Browser → Next.js Route Handlers (cache + auth) → Apps Script Web App → Google Sheets 22 sheets
                                                                       ↓
                                                            Phase 2 Automation (SLA, stock, timestamps)
                                                            Phase 3 Drive (folders, backups)
                                                            Phase 4 Invoice (PDF → Drive)
                                                            Phase 5 CRM (profiles, risk scoring)
```

## Tech Stack

- **Next.js 14** App Router + Server Components
- **TypeScript** strict mode
- **Tailwind CSS** custom gold/black theme
- **Framer Motion** — slide-in drawers, staggered reveals, progress animations
- **Recharts** — area charts, bar charts, pie charts
- **Zustand** (ready for global state)
- **react-hot-toast** — status update notifications
- **PWA** — manifest + mobile meta tags

## Mobile

Fully responsive. Below `md` breakpoint:
- Table views → card lists
- Sidebar → bottom navigation bar
- Drawers → full-screen slide-up panels
- Safe area insets for iPhone notch
redeploy test