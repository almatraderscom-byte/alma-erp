---
name: alma-finance-brief
description: Reads the money position — sales, expense, ledger dues, health — and answers in one prioritised Bangla brief. Use when Boss asks what came in, what went out, what is owed, or how the business is doing. Read-only.
version: 1.0.0
keywords: finance, ফাইন্যান্স, hisab, হিসাব, financial, লাভ, profit, khoroch, খরচ, ledger, লেজার, taka koto, ব্যালেন্স, cash, পাওনা, দেনা
---

# Finance brief — read the money, never move it

**কাজ:** Boss-কে ব্যবসার আর্থিক অবস্থার এক নজরে সৎ ছবি। শুধু **read** — টাকা নড়ানো নয়।
সব **whole-taka**, BDT, Asia/Dhaka।

## ধাপ

1. **Health (required):** `get_financial_health` — সামগ্রিক অবস্থা।
2. **Sales (required):** `get_sales_summary` — বিক্রি ও প্রবণতা।
3. **Expense (required):** `get_expense_summary` — খরচ।
4. **Ledger (required):** `get_ledger_balances` — পাওনা-দেনা/ব্যালেন্স।
5. **Detail (optional):** দরকার হলেই `list_recent_transactions` / `list_bills` — আগে নয়।

চারটা required read না হওয়া পর্যন্ত brief লিখো না। একটা fail করলে সেটা **নাম ধরে** বলো।

## Brief-এর ধরন

- আগে **নিট ছবি** (লাভ/ক্ষতি, হাতে কত, বড় দেনা), তারপর বিস্তারিত। ৫–৭ লাইন।
- প্রতিটা সংখ্যা কোনো একটা টুলের ফল। আসেনি মানে **সংখ্যা নেই** — বানিয়ো না।
- তুলনা করলে সময়কাল বলো ("গত মাসের চেয়ে"), নইলে সংখ্যাটা অর্থহীন।

## যেখানে থামবে

- **টাকা নড়ানোর অনুরোধ** — খরচ লিখে রাখা, বিল পরিশোধ, entry এডিট: এই skill-এ ওই টুলগুলো
  **নেই**। ঘুরপথ খুঁজো না — এক লাইনে বলো কাজটা এখান থেকে হবে না, তারপর থামো।
- **দুই টুলে দুই সংখ্যা** — নিজে গড় করে মিলিয়ে দিয়ো না। কোনটা কোথা থেকে এল, সেটা বলো।

## Traps

- **"এই মাস" মানে চলতি মাস**, আজকের তারিখ ধরে। মাসের ৩ তারিখে "এই মাসের খরচ" কম
  আসা স্বাভাবিক — কম দেখে ভুল ধরে নিয়ে গত মাসের হিসাব দেখিয়ে দিয়ো না।
- **অগ্রিম বেতন** পরে auto-recover হয়, তাই কোনো কর্মীর অগ্রিম "উধাও" মনে হতে পারে।
  ভুল বলার আগে ledger-এ জোড়া entry খুঁজে দেখো।

## Done

চারটা required read সফল, আর brief-এ নিট অবস্থা + বিক্রি + খরচ + দেনা — চারটাই আছে।
