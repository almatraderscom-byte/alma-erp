---
name: alma-finance-brief
description: Read-only financial summary — sales, expense, ledger, health.
version: 0.1.0
keywords: finance, ফাইন্যান্স, hisab, হিসাব, financial, লাভ, profit, khoroch, খরচ, ledger, লেজার, taka koto, ব্যালেন্স, cash
---

# Finance brief — read-only summary

**Goal:** Boss-কে ব্যবসার আর্থিক অবস্থার পরিষ্কার সারসংক্ষেপ। শুধু **read** — কোনো টাকা-নড়াচড়া নয়।
সব **whole-taka**, BDT, Asia/Dhaka।

## ধাপ

1. **Health (required):** `get_financial_health` — সামগ্রিক অবস্থা।
2. **Sales (required):** `get_sales_summary` — বিক্রি ও প্রবণতা।
3. **Expense (required):** `get_expense_summary` — খরচ।
4. **Ledger (required):** `get_ledger_balances` — পাওনা-দেনা/ব্যালেন্স।
5. **Detail (optional):** দরকারে `list_recent_transactions` / `list_bills`।

## Brief নিয়ম

- আগে **নিট ছবি** (লাভ/ক্ষতি, cash, বড় দেনা), তারপর বিস্তারিত। ৫-৭ লাইন।
- সংখ্যা সঠিক — বানিয়ে নয়। tool fail করলে "X আনতে পারিনি" বলো।
- কোনো payment/transfer/approve **নিজে করবে না** — শুধু জানাবে; সিদ্ধান্ত Boss-এর।

## Done

চারটি required read সম্পন্ন (বা fail হলে সৎভাবে উল্লেখ) + অগ্রাধিকার-সাজানো Bangla brief।
