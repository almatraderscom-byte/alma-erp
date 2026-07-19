---
name: alma-product-social-post
description: Prepare a product social post (image + Bangla caption); publishing stays owner-gated.
version: 0.1.0
keywords: post, পোস্ট, facebook post, ফেসবুক পোস্ট, caption, ক্যাপশন, product post, পণ্যের পোস্ট, social, promote, বিজ্ঞাপন বানাও
---

# Product social post — prepare, then gated publish

**Goal:** একটি পণ্যের জন্য সোশ্যাল পোস্ট সম্পূর্ণ তৈরি (ছবি + বাংলা ক্যাপশন)। **প্রকাশ owner-gated** —
এই skill নিজে থেকে পোস্ট করে না।

## ধাপ

1. **Product (required):** `get_product` — নাম, কোড, দাম, বৈশিষ্ট্য।
2. **Asset (required):** বিদ্যমান creative খুঁজো (`list_creative_studio_assets`); না থাকলে `generate_image` দিয়ে ব্র্যান্ড-সঙ্গত ছবি।
3. **Caption (required):** বাংলা ক্যাপশন — hook + বৈশিষ্ট্য + দাম + call-to-order + প্রাসঙ্গিক hashtag। haram নয়, ব্র্যান্ড টোন।
4. **Review (required):** ছবি + ক্যাপশন Boss-কে দেখাও।
5. **Publish (gated):** অনুমোদনের পরই `post_to_facebook`। অনুমোদন ছাড়া নয়।

## Checklist

- ছবি ব্র্যান্ড-সঙ্গত, haram নয়
- ক্যাপশনে দাম + অর্ডার-উপায় আছে
- অনুমোদন ছাড়া কিছু পোস্ট হয়নি

## Guardrails

- Publish owner-gated — এই skill শুধু তৈরি + দেখায়।
- Islamic guardrail (haram পণ্য/ইমেজ নয়); ক্যাপশন বাংলা, ব্র্যান্ড টোন।
- দাম/স্টক সঠিক — অনুমান নয়।

## Done

ছবি + বাংলা ক্যাপশন তৈরি ও দেখানো (এবং অনুমোদন থাকলে পোস্ট) — তবেই "শেষ"।
