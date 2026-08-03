---
name: media-transcoder
description: Converts media already on Boss's Mac with ffmpeg and sips — shrinking a video that is too big to send, trimming a clip, pulling audio out, turning a burst of photos into web-sized copies. Always writes a NEW file beside the original. Use when Boss says a file is too big to send or needs to be a different format.
version: 1.0.0
keywords: video boro, compress koro video, chhoto koro file, video trim, gif banao video theke, audio ber koro, ছবি ছোট করো, resize image, format bodlao, mp4 koro
---

# Mac-এ ভিডিও/ছবি রূপান্তর

**মূল ফাইল কখনো বদলায় না।** সবসময় পাশে নতুন নামে ফাইল তৈরি হয় (`-small`,
`-trimmed`), যাতে ভুল হলেও আসলটা থেকে যায়।

## আগে দেখো, তারপর কাজ

`which ffmpeg` চালাও (সঙ্গে সঙ্গে চলে)। **না থাকলে সেখানেই থামো** — Boss-কে বলো
ffmpeg নেই আর `brew install ffmpeg` তাঁর নিজের টার্মিনালে লাগবে; এই skill
নিজে কিছু ইনস্টল করে না। ছবির কাজ `sips` দিয়ে হয়, ওটা macOS-এই আছে।

## ধাপ

```
- [ ] ১. কোন ফাইল, এখন কত বড় (ls -lh / du -sh)
- [ ] ২. কী দরকার — ছোট? কাটা? অডিও? ফরম্যাট?
- [ ] ৩. এক কার্ডে কমান্ড, নতুন নামে আউটপুট
- [ ] ৪. আগে-পরে আকার মিলিয়ে দেখাও
```

## রেসিপি (এগুলোই ব্যবহার করো, নিজে বানিয়ো না)

- **ভিডিও ছোট করা (পাঠানোর মতো):**
  `ffmpeg -i IN.mp4 -vcodec libx264 -crf 28 -preset fast -acodec aac -b:a 128k OUT-small.mp4`
- **আরও ছোট, রেজোলিউশন কমিয়ে:** উপরের সাথে `-vf scale=1280:-2`
- **কাটা (শুরু ও সময়কাল):** `ffmpeg -ss 00:00:05 -i IN.mp4 -t 00:00:20 -c copy OUT-trimmed.mp4`
- **অডিও বের করা:** `ffmpeg -i IN.mp4 -vn -acodec libmp3lame -q:a 4 OUT.mp3`
- **GIF:** `ffmpeg -i IN.mp4 -vf "fps=12,scale=480:-1" -loop 0 OUT.gif` (ছোট রাখো,
  GIF দ্রুত বিশাল হয়ে যায়)
- **ছবি ছোট করা:** `sips -Z 1600 IN.jpg --out OUT-small.jpg`
- **ছবির ফরম্যাট:** `sips -s format jpeg IN.png --out OUT.jpg`

**সবসময় `--out`/আলাদা আউটপুট নাম** — `sips` ছাড়া `--out` দিলে সে **মূল ফাইলই
বদলে ফেলে**, আর সেটা ফেরানো যায় না।

## এই skill-এর নিজের নিষেধ

- **মূল ফাইলের উপর লেখা নয়** — আউটপুটের নাম ইনপুটের সমান হলে থামো।
- **`-y` (জোর করে চাপা দেওয়া) কখনো নয়** — একই নামের আউটপুট থাকলে থামো, নাম বদলাও।
- **কিছু ইনস্টল করা নয়** (brew, dmg) — নেই মানে নেই, Boss-কে সৎভাবে বলো।
- **২০টার বেশি ফাইল একসাথে নয়** — আগে সংখ্যা দেখিয়ে অনুমতি নাও।
- **ফাইল মোছা নয়** — পুরনো বড় ফাইল রাখার/সরানোর সিদ্ধান্ত Boss-এর।

## Boss-কে কী বলবে

এক লাইন: **কোন ফাইল · আগে কত · এখন কত · নতুন ফাইলটা কোথায়**। যেমন:
"WhatsApp Video 2026-06-06 — ২৮ MB থেকে ৬.৪ MB, `~/Downloads/…-small.mp4`।"
