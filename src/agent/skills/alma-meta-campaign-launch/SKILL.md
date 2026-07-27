---
name: alma-meta-campaign-launch
description: Plans a new Meta ad campaign end to end — objective, reach, daily budget, creative — validates it against the approved budget cap, then raises the owner card. Use when Boss asks for a campaign or a boost. The card is his click; Meta creates everything PAUSED.
version: 1.0.0
keywords: campaign, ক্যাম্পেইন, ad campaign, boost, বুস্ট, meta ads, facebook ad, বিজ্ঞাপন চালাও, launch ad, ad budget
---

# Meta campaign — plan fully, validate, then the owner gate

**Goal:** একটা নতুন Meta campaign সম্পূর্ণ পরিকল্পনা করে **যাচাই করে** Boss-এর কার্ডে তোলা।
টাকা এই skill-এর কথায় নড়ে না: card Boss-এর ক্লিক, আর অনুমোদনের পরও সব **PAUSED** তৈরি হয়।

## ধাপ

1. **Context (required):** `marketing_report` + `recommend_ad_actions` — এখন কী চলছে, কী সুপারিশ।
2. **Audience (required):** `list_audiences` + `get_customer_segments` — কাদের কাছে যাবে, কেন।
3. **Plan (required):** objective · দৈনিক budget · creative angle · সময়কাল — প্রতিটার পেছনে কারণ।
4. **Pre-flight (required):** `ads_campaign_plan` — অনুমোদিত budget cap, objective, UTM, pixel/CAPI
   সব যাচাই। **error থাকলে এখানেই থামো**, ঠিক করে আবার plan করো।
5. **Card (gated):** `launch_campaign` — Boss-এর approval card। অনুমোদনে campaign/ad set/creative সব
   **PAUSED** তৈরি হয়; Ads Manager-এ Boss নিজে চালু করবেন।

## Checklist

- objective · audience · দৈনিক budget · আনুমানিক মাসিক খরচ — চারটাই লেখা আছে
- `ads_campaign_plan` চলেছে এবং তার ফলাফল Boss-কে দেখানো হয়েছে
- বাজেট Boss-এর দেওয়া (নিজে ধরে নেওয়া নয়)
- অনুমোদন ছাড়া কিছু তৈরি হয়নি

## Guardrails

- সংখ্যা `marketing_report` থেকে — ROAS/CTR অনুমান করে বলবে না।
- validation error নিয়ে card তুলবে না।
- Boss বাজেট না বললে জিজ্ঞেস করো — ধরে নেওয়া বাজেট মানে ধরে নেওয়া খরচ।
- Islamic guardrail: haram পণ্য/ছবি প্রচার নয়।

## Done

যাচাই-হওয়া সম্পূর্ণ plan + আনুমানিক খরচ Boss-কে দেখানো হয়েছে এবং card তোলা হয়েছে — তবেই "শেষ"।
