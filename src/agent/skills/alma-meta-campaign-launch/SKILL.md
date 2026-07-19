---
name: alma-meta-campaign-launch
description: Plan a Meta campaign (objective/audience/budget/creative); launch + spend stay owner-gated.
version: 0.1.0
keywords: campaign, ক্যাম্পেইন, ad campaign, boost, বুস্ট, meta ads, facebook ad, বিজ্ঞাপন চালাও, launch ad, budget, audience
---

# Meta campaign — plan fully, launch only through the owner gate

**Goal:** একটা Meta campaign সম্পূর্ণ পরিকল্পনা (objective, audience, budget, creative)।
**Launch ও spend owner-এর ক্লিকে** — এই skill নিজে campaign চালু করে না বা টাকা খরচ করে না।

## ধাপ

1. **Context (required):** `marketing_report` + `recommend_ad_actions` — এখন কী চলছে, কী সুপারিশ।
2. **Audience (required):** `list_audiences` + `get_customer_segments` — কোন audience/segment টার্গেট।
3. **Plan (required):** objective + audience + দৈনিক budget + creative angle + সময়কাল — সব লিখে দাও, কারণসহ।
4. **Review (required):** পুরো plan Boss-কে দেখাও (বিশেষত budget)।
5. **Launch (gated):** অনুমোদনের পরই existing owner-gated ad tool (approval card) দিয়ে launch — এই skill থেকে সরাসরি নয়।

## Checklist

- objective/audience/budget/creative সব নির্দিষ্ট
- budget Boss-কে পরিষ্কার দেখানো হয়েছে
- কোনো spend/launch অনুমোদন ছাড়া হয়নি

## Guardrails

- সব খরচ owner-এর ক্লিকে — launch/scale/pause existing approval-card tool দিয়ে।
- অনুমান নয় — সংখ্যা marketing_report থেকে।

## Done

সম্পূর্ণ campaign plan (budget সহ) দেখানো হয়েছে (এবং অনুমোদন থাকলে launch) — তবেই "শেষ"।
