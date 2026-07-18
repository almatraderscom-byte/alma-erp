---
name: alma-seo-audit
description: Own-site SEO audit + Search Console/GA4 readout + prioritized fixes.
version: 0.1.0
keywords: seo, এসইও, seo audit, seo report, ranking, keyword, search console, ga4, website seo, সাইটের seo
---

# SEO — own-site audit + readouts + report

**Goal:** almatraders.com-এর মাসিক-মানের SEO readout: on-page audit, search performance,
keyword position, prioritized fix। কোনো সরাসরি live পরিবর্তন নয় — সব owner-gated প্রস্তাব।

## ধাপ

1. **On-page audit (required):** published catalog-এর title/meta/description/alt/slug অডিট; severity অনুযায়ী গ্রুপ। tool: `audit_product_seo`।
2. **Site health (required):** unpublished-in-stock, live-but-out-of-stock, thin category, missing image। tool: `get_website_health`।
3. **Search readout (required):** Search Console (clicks/impressions/CTR, top query+page) + indexing status। tools: `get_search_console_performance`, `get_indexing_status`।
4. **Traffic readout (required):** একই সময়সীমার GA4 (sessions, sources, conversions)। tool: `get_ga4_report`।
5. **Keywords (optional):** tracked-keyword টেবিল; owner-জিজ্ঞাসিত keyword-এ live ranking (Oxylabs — আগে approval)। tools: `list_tracked_keywords`, `research_seo_keywords`, `confirm_oxylabs_spend`।
6. **Deep crawl (optional):** owner full-site sweep চাইলে workbench-এ broken-link/status crawl। tools: `run_workbench_task`, `check_workbench_task`।
7. **Report (required):** score summary → severity-ভিত্তিক top issue → search+traffic readout → prioritized fix list (প্রতি fix-এ কোন product/page)। artifact publish। fix = `update_product_web` প্রস্তাব, owner approve করবে।

## Checklist

- অডিটের high-severity সব issue রিপোর্টে
- Search Console + GA4 একই সময়সীমার
- প্রতি সুপারিশ specific (কোন product/page, কী বদলাবে)
- কোনো live পরিবর্তন সরাসরি হয়নি — সব owner-gated

## Guardrails

- সাইটে সরাসরি লেখা/publish নয় — শুধু owner-gated প্রস্তাব (`update_product_web` / `publish_product`)।
- Oxylabs ranking check credit-approved হতে হবে।

## Done

সব required readout + severity-grouped report artifact — তবেই "শেষ"।
