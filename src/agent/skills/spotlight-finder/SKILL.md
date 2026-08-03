---
name: spotlight-finder
description: Finds a file on Boss's Mac from a plain-language description — last month's invoice PDF, that screenshot from Eid, the contract he cannot remember saving — by turning it into a Spotlight query and reporting the matches with their real paths and dates. Use when Boss is looking for a file and does not know where it is.
version: 1.0.0
keywords: file khujo, খুঁজে দাও ফাইল, kothay ache file, invoice pdf khujo, kon folder e ache, file ta pacchi na, ফাইল কোথায়, find file, search file mac
---

# Mac-এ ফাইল খোঁজা

Boss নাম ধরে বলেন না — বলেন "গত মাসের invoice-টা", "ঈদের সেই ছবিটা"। কাজ হলো
সেটাকে **Spotlight query**-তে অনুবাদ করা, আর যা পাওয়া গেল তার **আসল পথ ও তারিখ**
দেখানো। এই skill কিছু খোলে না, সরায় না, মোছে না।

## ধাপ

```
- [ ] ১. কী খুঁজছেন, এক লাইনে নিশ্চিত করো
- [ ] ২. query বানাও (নাম? ধরন? সময়?)
- [ ] ৩. চালাও, ফল গোনো
- [ ] ৪. বেশি হলে সংকীর্ণ করো, কম হলে শব্দ বদলাও
```

১. **কী** — তিনটা জিনিস আলাদা করো: **শব্দ** (invoice, চুক্তি), **ধরন** (pdf,
   ছবি, ভিডিও), **সময়** (গত মাস, ঈদের দিন)। কোনোটা অনুপস্থিত হলে আন্দাজ কোরো না —
   বাকিটা দিয়েই খোঁজো, তারপর দরকার হলে জিজ্ঞেস করো।

২. **query** — `mdfind` (Spotlight-এর নিজের ইঞ্জিন, তাই দ্রুত):
   - নামে শব্দ: `mdfind -name invoice`
   - ধরন + শব্দ: `mdfind "kMDItemContentType == 'com.adobe.pdf' && kMDItemFSName == '*invoice*'c"`
   - একটা ফোল্ডারে সীমিত: `mdfind -onlyin ~/Downloads invoice`
   - ভেতরের লেখাতেও: `mdfind "kMDItemTextContent == '*চুক্তি*'c"`
   বাইরের ফোল্ডার ছোঁয়ায় এগুলো **approval কার্ড** হয়ে যাবে — স্বাভাবিক, একবারে
   একটা ভালো query দাও, পাঁচটা আন্দাজি query নয়।

৩. **ফল** — শুধু পথ নয়, **তারিখ আর আকারসহ** দেখাও, নইলে Boss কোনটা তাঁর সেটা
   বুঝবেন না। ফল বেশি হলে গুনে বলো ("৮৩টা মিলেছে") আর সময়/ফোল্ডার দিয়ে ছেঁকে দাও।

৪. **না পেলে** — এক-দুইবার অন্য শব্দে চেষ্টা করো (বাংলা/ইংরেজি দুইভাবেই নাম
   থাকতে পারে), তারপর **সৎভাবে বলো পাইনি** — বানানো পথ কখনো দেখাবে না।

## এই skill-এর নিজের নিষেধ

- **কিছু খুলবে না, সরাবে না, মুছবে না** — শুধু খুঁজে দেখাবে।
- **কী/গোপন ফাইলের পথ দেখাবে না** — `.ssh`, `id_rsa`, `.env`, `.pem`, `.p8`
  জাতীয় পথ কমান্ডের আউটপুট থেকে **কোডেই মুছে দেওয়া হয়** (কতটা মুছল সেটাও
  বলা হয়), তাই তালিকা ছোট দেখালে সেটাই কারণ — নিজে ওগুলো খোঁজার চেষ্টাও কোরো না।
- **ফলের সংখ্যা বানাবে না** — যা এসেছে, গুনে তাই।

## Boss-কে কী বলবে

উপরে এক লাইনে **কয়টা মিলেছে আর কোন query-তে**, তারপর সর্বোচ্চ ৫–১০টা ফল:
**নাম · ফোল্ডার · তারিখ · আকার**। বাকিটা থাকলে "আরও ৭৩টা আছে, সংকীর্ণ করব?"
