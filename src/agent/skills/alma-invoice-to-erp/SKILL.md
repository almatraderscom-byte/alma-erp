---
name: alma-invoice-to-erp
description: Extract fields from an invoice/bill document into an ERP entry draft; the entry stays gated.
version: 0.1.0
keywords: invoice, ইনভয়েস, bill, বিল, receipt, রশিদ, expense entry, khoroch tulo, document, ডকুমেন্ট, erp te tulo, voucher
---

# Invoice → ERP — extract, verify, gated entry

**Goal:** একটা ইনভয়েস/বিল ডকুমেন্ট থেকে তথ্য বের করে ERP এন্ট্রির খসড়া। **এন্ট্রি owner-gated** —
টাকা-সম্পর্কিত, তাই যাচাই ছাড়া কিছু লেখা হয় না।

## ধাপ

1. **Fetch (required):** `get_document` / `search_documents` — ডকুমেন্টটা আনো/পড়ো।
2. **Extract (required):** vendor, তারিখ, খাত, পরিমাণ (whole-taka), invoice নম্বর — প্রতিটা field ডকুমেন্ট থেকে, অনুমান নয়।
3. **Dedup (required):** `list_bills` / `list_recent_transactions` — একই বিল আগে ওঠেনি তো (ডুপ্লিকেট এড়াও)।
4. **Verify (required):** বের-করা field Boss-কে দেখাও; অস্পষ্ট হলে জিজ্ঞেস করো, ধরে নিও না।
5. **Entry (gated):** অনুমোদনের পরই `log_expense` (owner-gated) — অনুমোদন ছাড়া নয়।

## Checklist

- প্রতিটা field ডকুমেন্ট থেকে (বানানো নয়)
- ডুপ্লিকেট চেক হয়েছে
- amount whole-taka; কোনো এন্ট্রি অনুমোদন ছাড়া হয়নি

## Guardrails

- Money-sensitive — যাচাই ছাড়া কোনো এন্ট্রি নয়; সংখ্যা whole-taka (roundMoney)।
- অস্পষ্ট হলে অনুমান নয়, Boss-কে জিজ্ঞেস।

## Done

যাচাই-করা field + ডুপ্লিকেট-চেক + (অনুমোদন থাকলে) এন্ট্রি — তবেই "শেষ"।
