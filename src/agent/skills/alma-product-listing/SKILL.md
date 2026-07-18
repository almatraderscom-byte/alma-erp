---
name: alma-product-listing
description: List/refresh a product on the website (SEO-clean title/meta/desc/alt); publish stays gated.
version: 0.1.0
keywords: product listing, পণ্য লিস্ট, listing, website e add, সাইটে তোল, publish product, product page, নতুন পণ্য, catalog
---

# Product listing — prepare a clean listing, gated publish

**Goal:** একটা পণ্য ওয়েবসাইটে SEO-পরিষ্কারভাবে লিস্ট/রিফ্রেশ করা (title, meta, description, alt)।
**Publish/update owner-gated** — এই skill খসড়া বানায়, প্রকাশ Boss-এর অনুমোদনে।

## ধাপ

1. **Product (required):** `get_product` + `get_website_catalog` — বর্তমান তথ্য, ইতিমধ্যে আছে কিনা।
2. **Draft (required):** SEO-পরিষ্কার title, meta, description, alt, slug — পূর্ণ before/after।
3. **Check (required):** `audit_product_seo` — খসড়া SEO-মান পাস করছে কিনা; ঘাটতি ঠিক করো।
4. **Propose (gated):** `update_product_web` / `publish_product` owner-gated card দিয়ে — সরাসরি নয়।
5. **Summary (required):** কী লিস্ট হলো, before→after, কোন proposal।

## Checklist

- title/meta/description/alt সব আছে ও SEO-পরিষ্কার
- audit পাস
- কোনো publish/update অনুমোদন ছাড়া হয়নি

## Guardrails

- publish/update/unpublish সবই owner approval card দিয়ে।
- দাম/স্টক/বৈশিষ্ট্য সঠিক — অনুমান নয়।

## Done

SEO-পাস খসড়া + owner-gated proposal তৈরি — তবেই "শেষ"।
