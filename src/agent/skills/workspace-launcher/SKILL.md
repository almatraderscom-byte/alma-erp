---
name: workspace-launcher
description: Opens a named set of apps and pages on Boss's Mac in one go — his work mode, his accounts mode — instead of him opening six things by hand. Use when Boss says to set up his Mac for a kind of work, or to open his usual apps.
version: 1.0.0
keywords: kajer mode, work mode chalu, hisab mode, amar app gulo kholo, sob kichu kholo, workspace, setup kore dao mac, roj er app
---

# "কাজের মোড" — একসাথে অ্যাপ খোলা

Boss একটা **মোডের নাম** বলেন, আর সেই মোডের অ্যাপগুলো একসাথে খুলে যায়। এই skill
শুধু **খোলে** — বন্ধ করে না, সাজায় না, ভেতরে কিছু টাইপ করে না।

## মোড (Boss যেভাবে বলেন)

| মোড | কী খোলে |
|---|---|
| **কাজের মোড** | Chrome · Terminal · ChatGPT |
| **হিসাব মোড** | Chrome (ERP-র হিসাব পাতা) · Numbers |
| **কোডের মোড** | Terminal · Cursor/VS Code · Chrome |

তালিকা বাঁধা নয় — Boss অন্যরকম চাইলে তাঁর বলা তালিকাই মোড, আর কাজ শেষে
এক লাইনে জিজ্ঞেস করো এই তালিকাটা মনে রাখব কিনা।

## ধাপ

```
- [ ] ১. কোন মোড, কী কী খুলবে — এক লাইনে বলো
- [ ] ২–৩. এক কার্ডেই সব খোলো (আগে আলাদা করে চেক নয়)
- [ ] ৪. কোনটা খুলল, কোনটা খুলল না — সত্যি বলো
```

১. **নিশ্চিত করা** — মোডের নাম আর তালিকাটা আগে লিখে দাও; Boss "না, Numbers লাগবে
   না" বলার সুযোগ পান।

২–৩. **এক কার্ডেই খোলা** — আলাদা করে `ls /Applications` দিয়ে আগে দেখতে যেয়ো না:
   ওটা বাইরের পথ, তাই **নিজেই একটা আলাদা কার্ড** হয়ে যায় আর Boss-কে দুইবার ট্যাপ
   করতে হয়। `open` নিজেই বলে দেয় অ্যাপটা নেই, তাই একবারেই চালাও:
   `open -a "Google Chrome"; open -a Terminal; open -a "ChatGPT"`
   (`;` দিয়ে — একটা না থাকলেও বাকিগুলো খুলবে; `&&` দিলে প্রথম ব্যর্থতাতেই থেমে যায়।)
   কোনো পেজ লাগলে একই কার্ডে: `open "https://alma-erp-six.vercel.app/agent"`।

৪. **ফল** — কোনগুলো খুলেছে সেটা বলো। **কিছু খোলেনি অথচ "খুলে দিয়েছি" বলা নিষিদ্ধ।**

## এই skill-এর নিজের নিষেধ

- **বন্ধ করা নয়** — `killall`/`pkill` কোডেই নিষিদ্ধ, আর এই skill ওদিকে যায়ও না।
- **ভেতরে টাইপ/click নয়** — সেটা `mac-ai-app-operator`-এর কাজ, আর শুধু দুইটা
  AI অ্যাপেই সম্ভব।
- **অচেনা লিংক খোলা নয়** — Boss-এর বলা বা আমাদের নিজের ঠিকানাই কেবল।
- **অ্যাপ ইনস্টল নয়।**

## Boss-কে কী বলবে

এক লাইন: **কোন মোড · কী কী খুলল · কিছু বাদ পড়লে কী আর কেন**।
