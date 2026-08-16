---
name: alma-marketing
description: Reads how marketing is actually going — spend and return, competitor creatives, what is on the calendar — and turns it into next week's plan. Use when Boss asks how marketing is doing or what to do next. Spend stays owner-gated.
version: 1.0.0
keywords: marketing, মার্কেটিং, প্রচার, marketing plan, weekly brief, competitor ad, competitor creative, roas, marketing kemon, prochar
---

# Digital marketing — plan, competitor scan, weekly brief

**Goal:** ডেটা-ভিত্তিক marketing readout ও plan: performance, competitor creative, calendar।
**সব spend owner-এর ক্লিকে** — এই skill শুধু বিশ্লেষণ + প্রস্তাব, কখনো নিজে campaign চালায় না।

## ধাপ

1. **Performance (required):** lookback window-এর marketing report (paid spend/ROAS, funnel, organic) + campaign সুপারিশ। tools: `marketing_report`, `recommend_ad_actions`।
   - **Meta-র নিজের সুপারিশ আলাদা জিনিস** — Boss ফোনে যে ads নোটিফিকেশন পান সেগুলো `get_ad_recommendations` দিয়ে পড়ো (`recommend_ad_actions` আমাদের নিজের বিশ্লেষণ, ওটা নয়)। বাকি (open) সুপারিশ থাকলে brief-এ আলাদা করে বলো, আর Boss সিদ্ধান্ত দিলে `resolve_ad_recommendation` দিয়ে বন্ধ করো।
2. **Competitor scan (required):** competitor ad creative (ad library/research); যে angle বারবার আসে — সেগুলোই কাজ করছে। tools: `research_competitor_creatives`, `get_marketing_intel`।
3. **Calendar (required):** content calendar + retail date; আগামী ২ সপ্তাহের planned content + ফাঁক। tools: `list_content_calendar`, `list_important_dates`।
4. **Plan (optional):** `plan_marketing` দিয়ে খসড়া (owner approval card খোলে)। এই skill থেকে **কখনো সরাসরি campaign launch/scale/pause বা spend নয়** — শুধু সুপারিশ; execution existing owner-gated tool দিয়ে।
5. **Brief (required):** weekly performance brief — কী চলেছে, কী ফেরত, competitor angle, পরের সপ্তাহে কী (প্রতিটার পেছনের ডেটাসহ)। artifact publish।

## যে সংখ্যা বোঝোনি, তার গল্প বানিও না

**2026-07-27, Boss নিজে ধরেছেন।** report-এ "৬৫৩টা alert" এসেছিল। এই skill বলে
প্রতিটা সুপারিশের পেছনে সংখ্যা দিতে — সেটা দেওয়া হয়েছিল, কিন্তু সংখ্যাটা **কীসের**
তা না দেখেই তার একটা কারণ বানানো হয়েছিল ("লিড আসছে, রিপ্লাই হচ্ছে না")। Boss
জিজ্ঞেস করতেই উল্টো দিকের আরেকটা অনুমান বলা হয়েছিল।

নিয়ম: একটা সংখ্যা **রিপোর্ট করা** আর তার **ব্যাখ্যা দেওয়া** এক জিনিস নয়।
ব্যাখ্যা দিতে হলে আগে ভেতরটা খোলো (কোন ধরনের, কোন সময়ের, কে বানায়)। খুলতে
না পারলে সংখ্যাটা বলো আর সোজা বলো — "এটা কীসের, নিশ্চিত নই"।

## Checklist

- প্রতি সুপারিশের পেছনের সংখ্যা (spend/ROAS/CTR) brief-এ
- competitor scan থেকে অন্তত ২টা কাজে-লাগানো angle
- কোনো spend/campaign পরিবর্তন সরাসরি হয়নি — সব owner-gated

## Guardrails

- সব খরচ owner-এর ক্লিকে — এই skill শুধু বিশ্লেষণ + প্রস্তাব।
- Campaign launch/pause/budget বদল শুধুই existing approval-card tool দিয়ে।

## Done

সব required ধাপ + weekly brief artifact — তবেই "শেষ"।
