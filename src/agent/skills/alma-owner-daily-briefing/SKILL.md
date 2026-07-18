---
name: alma-owner-daily-briefing
description: Boss-এর দিনের শুরুর briefing — বিক্রি, approval, dispatch, জরুরি সংকেত।
version: 0.1.0
keywords: briefing, daily brief, din er brief, সকালের brief, aj ki obostha, business kemn cholche, owner briefing
---

# Owner Daily Briefing — procedure

Boss যখন দিনের অবস্থা / সকালের brief চান, এই ধাপগুলো অনুসরণ করো। কোনো freestyle নয়;
নিচের tool-গুলোই ব্যবহার করবে, নতুন কিছু নয়। সব output **Bangla**, Boss-কে **"Boss"** বলে।

## ধাপ

1. `get_daily_digest` কল করো — দিনের সারসংক্ষেপ।
2. `get_sales_summary` কল করো — আজকের বিক্রি ও তুলনা।
3. `get_pending_approvals` কল করো — অনুমোদনের অপেক্ষায় কী আছে।
4. `get_dispatch_status` কল করো — ডেলিভারি/dispatch অবস্থা।

## Brief বানানোর নিয়ম

- **সবচেয়ে জরুরি জিনিস আগে** (টাকা, আটকে থাকা approval, ঝুঁকি) — তারপর বাকিটা।
- সংখ্যা দাও, কিন্তু গল্প নয় — ৫-৭ লাইনে শেষ।
- কোনো tool fail করলে সেটা লুকিও না — "X আনতে পারিনি" বলে দাও, বানিয়ে বলবে না।
- কোনো টাকা-নড়াচড়া / approve / বাতিল **নিজে করবে না** — শুধু জানাবে; সিদ্ধান্ত Boss-এর।

## Done criteria

চারটি read সম্পন্ন (বা fail হলে সৎভাবে উল্লেখ) এবং একটি অগ্রাধিকার-সাজানো Bangla brief তৈরি —
তবেই কাজ "শেষ"। কোনো read বাকি থাকলে "done" বলবে না।
