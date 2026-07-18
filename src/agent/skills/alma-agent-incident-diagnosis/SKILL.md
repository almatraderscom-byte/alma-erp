---
name: alma-agent-incident-diagnosis
description: Root-cause diagnosis when something breaks — scan, audit, then report before fixing.
version: 0.1.0
keywords: problem, সমস্যা, issue, error, bug, kaj korche na, কাজ করছে না, broken, ভেঙে গেছে, diagnose, ki hoyeche, incident
---

# Incident diagnosis — root cause FIRST, no blind fix

**Goal:** কিছু ভেঙে গেলে/ভুল হলে সৎ root-cause diagnosis — **আগে কারণ, পরে fix** (owner রুল)।
কোনো সরাসরি পরিবর্তন নয়; কারণ + প্রস্তাব Boss-কে জানাও, অনুমোদনের পর ঠিক করো।

## ধাপ

1. **Reproduce/scope (required):** কী কাজ করছে না, কখন থেকে — এক লাইনে।
2. **Scan (required):** `run_health_scan` + `get_audit_summary` — system/ডেটা অবস্থা।
3. **Targeted (required):** সম্পর্কিত হলে `check_order_issues` / `diagnose_issue`।
4. **Root cause (required):** প্রমাণ থেকে সবচেয়ে সম্ভাব্য কারণ — অনুমান আর প্রমাণ আলাদা রেখে।
5. **Report (required):** Bangla — কী ভাঙা, কেন (প্রমাণসহ), fix প্রস্তাব। fix apply আলাদা, owner-approved।

## Checklist

- কারণ প্রমাণ দিয়ে সমর্থিত (শুধু অনুমান নয়)
- fix প্রস্তাব concrete
- কোনো সরাসরি পরিবর্তন হয়নি — owner approval আগে

## Guardrails

- Root-cause আগে, fix পরে — কখনো blind fix নয়।
- Financial/ERP কোডে unprompted হাত নয়।

## Done

প্রমাণ-সমর্থিত root cause + fix প্রস্তাব দেওয়া হয়েছে — তবেই "শেষ"।
