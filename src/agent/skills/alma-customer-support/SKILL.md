---
name: alma-customer-support
description: Customer inbox/comments → drafted replies (sending stays owner/CS-gated).
version: 0.1.0
keywords: customer, কাস্টমার, inbox, messenger, message, মেসেজ, comment, কমেন্ট, reply, জবাব, whatsapp, cs, খদ্দের
---

# Customer support — read, draft, gated send

**Goal:** কাস্টমার inbox/comment দেখে জবাবের খসড়া তৈরি। **পাঠানো owner/CS-gated** — এই skill
নিজে থেকে কাস্টমারকে মেসেজ পাঠায় না (CS mode/approval আগের মতোই খাটবে)।

## ধাপ

1. **Scan (required):** `get_fb_messenger_inbox` + `get_wa_inbox` + `get_unanswered_comments` — কী জবাব বাকি।
2. **Context (optional):** `get_customer_summary` — কাস্টমারের আগের ইতিহাস।
3. **Draft (required):** প্রতিটা জবাবের **বাংলা খসড়া** — ভদ্র, সংক্ষিপ্ত, সঠিক তথ্য (দাম/available হলে)।
4. **Send (gated):** owner/CS অনুমোদনের পরই `send_customer_message` / `reply_to_comment`। অনুমোদন ছাড়া নয়।

## Checklist

- প্রতিটা বাকি জবাবের খসড়া তৈরি
- কোনো মেসেজ অনুমোদন ছাড়া যায়নি
- ভুল/অনিশ্চিত তথ্য বানিয়ে নয় — না জানলে Boss-কে জিজ্ঞেস

## Guardrails

- কাস্টমার-facing সব বাংলা; haram পণ্য/ছবি নয় (Islamic guardrail)।
- Send সবসময় gated — CS mode off হলে শুধু খসড়া দেখাও।
- দাম/স্টক অনিশ্চিত হলে অনুমান নয়।

## Done

সব বাকি জবাবের খসড়া + (অনুমোদন থাকলে) পাঠানো — তবেই "শেষ"।
