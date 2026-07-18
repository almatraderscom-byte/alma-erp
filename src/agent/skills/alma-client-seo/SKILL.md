---
name: alma-client-seo
description: End-to-end SEO audit of ANY site + owner-gated execution; login/DNS/publish stay owner-only.
version: 0.1.0
keywords: client seo, ক্লায়েন্ট seo, customer website, অন্য সাইটের seo, website audit, seo service, client site, cdit seo
---

# Client SEO — end-to-end audit of ANY website, then owner-gated execution

**Goal:** একটি ক্লায়েন্ট (বা যেকোনো) সাইট world-class SEO expert-এর মতো end-to-end audit,
তারপর পূর্ণ fix plan — কিন্তু **প্রতিটা critical / login / irreversible ধাপ owner-এর হাতে**,
কখনো agent নিজে নয়।

## ধাপ

1. **Full audit (required):** দেওয়া সাইটের পূর্ণ crawl+audit চালাও এবং **শেষ হওয়া পর্যন্ত অপেক্ষা করো** (poll)। পুরো রিপোর্ট পড়ো — score, site-level issue, per-page issue (severity)। tools: `run_website_seo_audit`, `check_website_seo_audit`।
2. **Keyword context (optional):** key term-এ সাইট কোথায় rank করে (siteDomain = client domain; Oxylabs — আগে owner spend approval)। competitor-এর সাথে gap। tools: `confirm_oxylabs_spend`, `research_seo_keywords`, `research_competitor`।
3. **Diagnose (required):** findings → prioritized fix plan: critical → high → medium → low, প্রতি fix concrete (কোন পেজ, কী বদলাবে, expected impact)। **যেগুলো তুমি তৈরি করতে পারো** আর **যেগুলোতে owner লাগবে** — আলাদা করো।
4. **Audit report (required):** audit + fix plan Bangla artifact হিসেবে publish: score, প্রতিটা issue, prioritized plan, আর কোন ধাপ owner-only (login / DNS / hosting / publish / paid tool)।
5. **Execute safe (optional):** credential বা irreversible action ছাড়া যা তৈরি করা যায় — copy, meta, alt-text, schema, content — তৈরি করে owner-gated proposal / workbench PR হিসেবে ship। **কখনো client সাইটে login, DNS/hosting বদল, বা সরাসরি publish নয়।** tools: `run_workbench_task`, `check_workbench_task`, `draft_seo_fixes`।
6. **Owner handoff (required):** CRITICAL / login-required / irreversible ধাপগুলো owner-এর জন্য পরিষ্কার checklist (প্রতিটায় ঠিক কী click/change)। pause-checkpoint দিয়ে owner-কে করতে দাও, তারপর continue। handoff list দেওয়া হলে এই ধাপ "শেষ"।

## Checklist

- পুরো সাইট crawl হয়েছে (score + severity-ভিত্তিক issue list)
- প্রতি সুপারিশ specific (কোন পেজ, কী, কেন)
- কোন কাজ agent করেছে vs owner — পরিষ্কার আলাদা
- কোনো login/DNS/hosting/publish agent নিজে করেনি — সব owner-handoff-এ

## Guardrails

- AUDIT পুরোপুরি read-only (crawl কিছু submit করে না)।
- CRITICAL / login-লাগে / irreversible সব ধাপ owner-এর হাতে — agent কখনো client সাইটে login করবে না, DNS/hosting বদলাবে না, সরাসরি publish করবে না।
- Password agent টাইপ করবে না, CAPTCHA bypass করবে না — owner-কে দেবে।
- Fix apply শুধু owner-gated proposal / PR; client-এর CMS-এ সরাসরি লেখা নয়।

## Done

Full crawl + prioritized plan + agent-vs-owner split + owner-handoff checklist — তবেই "শেষ"।
