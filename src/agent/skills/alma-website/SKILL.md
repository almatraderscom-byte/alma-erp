---
name: alma-website
description: Website improvements shipped as PROPOSALS / PRs only — never a direct live change.
version: 0.1.0
keywords: website, ওয়েবসাইট, product page, landing page, site content, পণ্যের পেজ, সাইট ঠিক কর, web copy, meta
---

# Website — improvements shipped as PROPOSALS / PRs only

**Goal:** website content/product-page উন্নতি সম্পূর্ণ তৈরি, কিন্তু ship হয় **শুধু owner-gated
proposal বা PR হিসেবে** — কখনো সরাসরি live পরিবর্তন নয়।

## ধাপ

1. **Baseline (required):** বর্তমান অবস্থা পড়ো — catalog + health + (content কাজ হলে) improve-হবে এমন live পেজ fetch। tools: `get_website_catalog`, `get_website_health`, `fetch_website_page`।
2. **Draft (required):** প্রতি পেজ/প্রোডাক্টে উন্নত copy/structure (title, meta, description, alt) — প্রতিটার পূর্ণ before/after।
3. **Propose (required):** প্রতিটা পরিবর্তন owner-gated প্রস্তাব হিসেবে (`update_product_web` / `publish_product` / `unpublish_product`)। কোড-লেভেল সাইট পরিবর্তন workbench-এ **PR হিসেবে তৈরি — কখনো সরাসরি deploy নয়**। tools: `run_workbench_task`, `check_workbench_task`।
4. **Summary (required):** change summary — প্রতিটা touched পেজ/প্রোডাক্ট, before → after, কোন proposal/PR বহন করছে। artifact publish।

## Checklist

- প্রতি পরিবর্তনের before → after artifact-এ
- সব পরিবর্তন proposal/PR আকারে — কিছুই সরাসরি live হয়নি
- PR হলে preview link owner-কে দেওয়া হয়েছে

## Guardrails

- PR-only, always — workbench কখনো সরাসরি deploy করে না।
- publish/unpublish/feature/update সবই owner approval card-এর ভেতর দিয়ে।

## Done

সব required ধাপ + change-summary artifact (before→after সহ) — তবেই "শেষ"।
