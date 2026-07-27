---
name: alma-website
description: Finds what is actually wrong with almatraders.com — broken pages, health, structure, anything needing a code change — and delivers it as an owner-gated proposal or a workbench PR, never a live edit. Use when Boss asks what is wrong with the site or wants a site change that is not page copy.
version: 1.0.0
keywords: website, ওয়েবসাইট, site content, landing page, সাইটের সমস্যা, site broken, page broken, sitename kaj korche na, website health, workbench
---

# Website — improvements shipped as PROPOSALS / PRs only

**Goal:** website content/product-page উন্নতি সম্পূর্ণ তৈরি, কিন্তু ship হয় **শুধু owner-gated
proposal বা PR হিসেবে** — কখনো সরাসরি live পরিবর্তন নয়।

## ধাপ

1. **Baseline (required):** বর্তমান অবস্থা পড়ো — catalog + health + (content কাজ হলে) improve-হবে এমন live পেজ fetch। tools: `get_website_catalog`, `get_website_health`, `fetch_website_page`।
2. **Draft (required):** কী বদলাতে হবে — গঠন, ভাঙা লিংক, টেমপ্লেটের ফাঁক, কোড — প্রতিটার পূর্ণ before/after।
   **পেজের লেখা এই skill-এর কাজ নয়** (title/meta/alt/description) — সেটা `seo-fixing-own-site`; দরকার হলে Boss-কে বলে দাও।
3. **Propose (required):** কোড-লেভেল পরিবর্তন workbench-এ **PR হিসেবে — কখনো সরাসরি deploy নয়**।
   tools: `run_workbench_task`, `check_workbench_task`।
   পণ্যের row বদলানোর টুলগুলো এই skill-এর হাতে **নেই** — ওটা `alma-product-listing`।
   দরকার হলে Boss-কে সেটাই বলো, ঘুরপথ খুঁজো না।
4. **Summary (required):** change summary — প্রতিটা ছোঁয়া পেজ, before → after, কোন proposal/PR বহন করছে। artifact হিসেবে সেভ করো।

## Checklist

- প্রতি পরিবর্তনের before → after artifact-এ
- সব পরিবর্তন proposal/PR আকারে — কিছুই সরাসরি live হয়নি
- PR হলে preview link owner-কে দেওয়া হয়েছে

## Guardrails

- PR-only, always — workbench কখনো সরাসরি deploy করে না।
- পণ্য publish/unpublish/update এই skill করে না — টুলগুলোই দেওয়া হয়নি।

## Done

সব required ধাপ + change-summary artifact (before→after সহ) — তবেই "শেষ"।
