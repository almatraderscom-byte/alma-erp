---
name: alma-agent-incident-diagnosis
description: Finds the root cause when one of our own systems misbehaves — the agent, the ERP, a job that stopped, orders that stopped syncing. Use when Boss says something is not working and wants to know WHY. Holds no write tool; it reports the cause, it does not fix.
version: 1.0.0
keywords: kaj korche na, কাজ করছে না, kaj kore na, error, এরর, bug, broken, ভেঙে গেছে, bondho hoye geche, বন্ধ হয়ে গেছে, keno hocche na, atke ache, incident, root cause, diagnose
---

# Incident diagnosis — root cause FIRST, no blind fix

**Goal:** আমাদের নিজেদের কিছু (agent, ERP, কোনো job, order sync) ভুল করলে **কেন** সেটা প্রমাণসহ বের
করা। এই skill-এর হাতে কোনো write টুল নেই — সেটাই গ্যারান্টি: যে কারণ বের করল, সে নিজে বদলাতে পারে না।

## ধাপ

1. **Scope (required):** কী কাজ করছে না, কখন থেকে — এক লাইনে। অস্পষ্ট হলে আগে সেটাই জিজ্ঞেস করো।
2. **Scan (required):** `run_health_scan` + `get_audit_summary` — সিস্টেম/ডেটার অবস্থা।
3. **Targeted (required if relevant):** অর্ডার-সম্পর্কিত হলে `check_order_issues`; কোড/লগ-সম্পর্কিত হলে `diagnose_issue`।
4. **Root cause (required):** প্রমাণ থেকে সবচেয়ে সম্ভাব্য কারণ — **প্রমাণ আর অনুমান আলাদা করে** লেখো।
5. **Report (required):** কী ভাঙা · কবে থেকে · কোন টুল কী দেখাল · কারণ · প্রস্তাবিত fix। fix apply আলাদা কাজ।

## Checklist

- কারণ প্রমাণ দিয়ে সমর্থিত — কোন টুলের কোন লাইন থেকে, সেটা লেখা আছে
- অনুমানের জায়গায় "অনুমান" লেখা আছে
- fix প্রস্তাব concrete (কোথায়, কী বদলাতে হবে)
- কিছু বদলানো হয়নি — এই skill বদলাতেই পারে না

## Guardrails

- Root cause আগে, fix পরে — blind fix কখনো নয় (owner রুল)।
- স্ক্যান পরিষ্কার এলে "সব ঠিক" নয় — কী দেখা হয়েছে আর কী দেখা যায়নি, দুটোই বলো।
- Financial/ERP কোডে unprompted হাত নয়।

## Done

প্রমাণ-সমর্থিত root cause + concrete fix প্রস্তাব Boss-কে দেওয়া হয়েছে — তবেই "শেষ"।
