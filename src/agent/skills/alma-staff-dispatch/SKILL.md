---
name: alma-staff-dispatch
description: Staff task/attendance/location → dispatch decision (assignment stays gated).
version: 0.1.0
keywords: staff, স্টাফ, kormi, কর্মী, dispatch, ডেলিভারি, delivery, kaj dao, task dao, ke ache, hajira, হাজিরা, assign
---

# Staff dispatch — who does what

**Goal:** স্টাফের বর্তমান অবস্থা (কাজ, হাজিরা, লোকেশন) দেখে সঠিক dispatch/assign সিদ্ধান্তে
পৌঁছানো। নতুন কাজ assign করা হয় **existing owner-gated dispatch/task card** দিয়ে — এই skill
তথ্য জোগায় ও সুপারিশ করে।

## ধাপ

1. **Who (required):** `get_all_staff` + `get_attendance` — আজ কে আছে/উপস্থিত।
2. **Load (required):** `get_staff_tasks` — কার কী কাজ চলছে (কে ফাঁকা)।
3. **Location (optional):** `get_staff_location` — কাছের/উপযুক্ত জন কে।
4. **Dispatch state (optional):** `get_dispatch_status` — ডেলিভারি/dispatch অবস্থা।
5. **Recommend (required):** কাকে কোন কাজ — কারণসহ (হাজির + ফাঁকা + কাছে)। assignment owner-gated card দিয়ে; এই skill নিজে assign করে না।

## Checklist

- সুপারিশ হাজির + available স্টাফের মধ্যে
- প্রতিটা assignment-এর কারণ পরিষ্কার
- কোনো assign সরাসরি হয়নি — card/owner দিয়ে

## Guardrails

- Assignment/notification existing owner-gated tool দিয়ে — এই skill শুধু তথ্য + সুপারিশ।
- স্টাফ মেসেজ বাংলায়; Boss-facing report-এ "Boss"।

## Done

উপস্থিতি+কাজ+সুপারিশ দেওয়া হয়েছে — তবেই "শেষ"।
