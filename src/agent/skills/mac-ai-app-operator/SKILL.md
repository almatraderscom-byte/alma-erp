---
name: mac-ai-app-operator
description: Operates the Claude and ChatGPT desktop apps on Boss's own Mac through the accessibility tree: opens a fresh chat, confirms which conversation is on screen, types a prompt, sends it, reads the answer back. Use when Boss asks to send or ask something in an AI app on his Mac, or to see what one is showing.
version: 1.0.0
keywords: chatgpt, chatgpt app, claude app, notun chat, new chat, নতুন চ্যাট, app e likhe, app e jigges, desktop app, ai app, mac app, chat khulo, oi chat e
---

# Boss-এর Mac-এর AI অ্যাপ চালানো

দুইটাই অ্যাপ চালানো যায় — **Claude** আর **ChatGPT** (`list_mac_apps`-এ তালিকা)।
অন্য কোনো অ্যাপ কোডেই নিষিদ্ধ; Boss চাইলে সৎভাবে বলো ওটা যোগ করতে deploy লাগে।

## ধাপ

```
- [ ] ১. দেখো (tree) — element-এর হুবহু নাম নাও
- [ ] ২. কোন চ্যাট, নিশ্চিত করো (session)
- [ ] ৩. দরকার হলে নতুন চ্যাট (new_chat, নিজের খোঁজা click নয়)
- [ ] ৪. লেখো (type) → পাঠাও (key enter)
- [ ] ৫. উত্তর পড়ো (tree + fullTree) — তারপরই Boss-কে বলো
```

১. **দেখা আগে, সবসময়** — `look_mac_app` action="tree"। এটা সঙ্গে সঙ্গে চলে, কিছু
   বদলায় না। click/type-এ `elementLabel` লাগে **tree থেকে হুবহু**; নিজের আন্দাজে
   label বানিয়ে দিলে টুল না বলবে, আর সেটাই ঠিক। tree-তে element না থাকলে
   **থামো** — স্ক্রল করে (action="scroll") আবার দেখো, নয়তো Boss-কে বলো কী দেখছ।

২. **কোন চ্যাট** — `look_mac_app` action="session" দিয়ে খোলা চ্যাটের পরিচয় পড়ো
   (title, প্রথম মেসেজ, composer খালি কিনা)। এরপর প্রতিটা type/click-এ
   `expectSession` দিয়ে সেটাই ফেরত পাঠাও। Mac কাজ করার ঠিক আগে মিলিয়ে দেখে, না
   মিললে **কিছু না করে** `session_mismatch` ফেরত দেয়। ভুল চ্যাটে লেখা হওয়ার চেয়ে
   থেমে যাওয়া ভালো — mismatch এলে Boss-কে বলো, নিজে আরেকটা চ্যাট খুঁজো না।

৩. **নতুন চ্যাট** — `drive_mac_app` action="new_chat"। tree থেকে "New chat"-জাতীয়
   বোতাম খুঁজে নিজে click **কোরো না**: new_chat অ্যাপের নিজের পথে যায়, প্রমাণ করে
   নতুন খালি চ্যাট খুলেছে, আর নতুন session ফেরত দেয় — সেটাই পরের type-এর
   `expectSession`। Boss কোনো **চলমান** চ্যাটের কথা বললে নতুন চ্যাট খুলবে না।

৪. **লেখা ও পাঠানো** — `drive_mac_app` action="type" (elementLabel = composer,
   `text` = হুবহু যা লিখতে হবে), তারপর action="key" `key="enter"` সঙ্গে
   `focusedLabel` (tree-তে যে element-এ ফোকাস)। **প্রতিটা act নিজে থেকেই Boss-এর
   ফোনে approval card হয়ে যায়** — আলাদা করে আগে অনুমতি চেয়ো না, টুল ডেকে বলো কার্ড
   পাঠিয়েছি। approve হওয়ার পর ফল `check_mac_command` দিয়ে নাও (ফেরত পাওয়া id দিয়ে)।

৫. **উত্তর পড়া** — `look_mac_app` action="tree" **`fullTree: true`**। সাধারণ tree-তে
   শুধু বোতাম/বক্সের নাম আসে, কথোপকথনের লেখা আসে না — তাই fullTree ছাড়া "উত্তর
   এসেছে" বলা আন্দাজ। screenshot-এ `screenContents` থাকলে সেটাও পড়তে পারো; না
   থাকলে ছবি দেখে অনুমান কোরো না। উত্তর লম্বা হলে scroll করে বাকিটা নাও।

## যেসব উত্তর ব্যর্থতা নয়

- **owner_active** — Boss নিজেই কীবোর্ডে আছেন। একটু পরে আবার চেষ্টা। তিনবারেও
  একই হলে থামো এবং বলো "আপনি টাইপ করছেন, পরে করি"।
- **field_not_empty** — বক্সে Boss-এর আগের লেখা আছে। `replace: true` **শুধু এই
  উত্তরের পরেই**, আর কার্ডে Boss-কে বলো তাঁর draft মুছে যাবে।
- **session_mismatch** — উপরের ৩ নম্বর। থামো, জানাও।
- **Mac অফলাইন** — ঘুমিয়ে আছে বা এজেন্ট বন্ধ। `mac_agent_status` দিয়ে দেখে সত্যিটা
  বলো; কার্ড বানিয়ে ফেলে রেখো না।

## ভুল হলে

লেখা ভুল জায়গায় বা ভুলভাবে গেলে **আবার টাইপ করে ঠিক করার চেষ্টা কোরো না** —
আগে `look_mac_app` tree দিয়ে এখন কী অবস্থা পড়ো, তারপর Boss-কে এক লাইনে বলো কী
হয়েছে আর কী করলে ঠিক হয়। অন্ধ পুনরাবৃত্তি দুইটা ভুল বার্তা পাঠায়, একটা নয়।

## এই skill-এর নিজের নিষেধ

- **অন্য অ্যাপ নয়** — শুধু Claude আর ChatGPT। বাকিটা কোডেই বন্ধ।
- **পাসওয়ার্ড, API key, OTP, `.env`-এর কিছু কখনো টাইপ করবে না** — Boss বললেও নয়;
  বলো তিনি নিজে টাইপ করবেন।
- **Delete / payment / permission বোতামে click নয়** — approve করেও ওটা চলে না।
- **স্ক্রিনশটের base64 কখনো উত্তরে ঢালবে না** — লিংকই দেখানোর জিনিস।
- **কোড লেখার কাজ এই পথে নয়** — অ্যাপে টাইপ করে বড় কোডের কাজ করানো ধীর ও
  ভঙ্গুর; ওটা CLI সেশনের কাজ। Boss কোড করাতে চাইলে বলো, নিজে অ্যাপে শুরু কোরো না।

## Boss-কে কী বলবে

কাজ শেষে এক-দুই লাইন: **কোন অ্যাপ, কোন চ্যাট, কী পাঠানো হয়েছে, কী উত্তর এসেছে**।
উত্তর না পড়ে "পাঠিয়ে দিয়েছি, উত্তর এসেছে" বলবে না — পাঠানো আর উত্তর আসা দুইটা
আলাদা ঘটনা, আর দ্বিতীয়টার প্রমাণ fullTree।
