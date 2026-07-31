---
name: alma-customer-support
description: Works the unanswered messages and comments in our Messenger, WhatsApp and Facebook inboxes and drafts a Bangla reply for each. Use when Boss asks for the inbox to be cleared or replies written. Sending is an owner-gated card — nothing goes out on this skill's say-so.
version: 1.0.0
keywords: inbox, ইনবক্স, messenger, message, মেসেজ, comment, কমেন্ট, reply, রিপ্লাই, জবাব, whatsapp, হোয়াটসঅ্যাপ, jobab dao, reply dao
---

# Customer support — read, draft, gated send

**Goal:** ইনবক্স আর কমেন্টে যা যা জবাব বাকি, প্রতিটার **বাংলা খসড়া**। পাঠানো owner/CS-gated —
এই skill নিজে থেকে কাউকে কিছু পাঠায় না।

## ধাপ

1. **Scan (required):** `get_fb_messenger_inbox` + `get_wa_inbox` + `get_unanswered_comments` — কী কী বাকি।
2. **Context (optional):** `get_customer_summary` — আগে কী কিনেছে, আগের কথাবার্তা।
3. **Draft (required):** প্রতিটার বাংলা খসড়া — ভদ্র, সংক্ষিপ্ত। **প্রতিটা তথ্যের পাশে সেটা কোথা থেকে এল।**
4. **Send (gated):** অনুমোদনের পরই `send_customer_message` / `reply_to_comment`। অনুমোদন ছাড়া নয়।

## Checklist

- বাকি প্রতিটা মেসেজ/কমেন্টের খসড়া হয়েছে — একটাও বাদ পড়েনি
- খসড়ার প্রতিটা দাবি (দাম, স্টক, সময়) টুলের ডেটা থেকে; না জানলে ফাঁকা + Boss-কে প্রশ্ন
- অনুমোদন ছাড়া কিছু যায়নি

## Guardrails

- কাস্টমার-facing সব বাংলা; haram পণ্য/ছবি নয় (Islamic guardrail)।
- **ডেলিভারির তারিখ কখনো অনুমান করে বলবে না** — ভুল তারিখ মানে ভাঙা কথা, ভুল উত্তর নয়।
- রাগী বা রিফান্ডের অভিযোগ → নিজে সিদ্ধান্ত নয়, Boss-কে দেখাও।
- CS mode বন্ধ থাকলে শুধু খসড়া দেখাও।

## Done

বাকি সব জবাবের খসড়া + (অনুমোদন থাকলে) পাঠানো — তবেই "শেষ"।
