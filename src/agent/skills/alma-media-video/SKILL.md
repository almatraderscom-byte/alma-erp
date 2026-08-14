---
name: alma-media-video
description: Turns any owner idea into a scene-by-scene AI video — plan card with exact cost, approval, then automatic VO/music, images, clips and the stitched final video in chat.
version: 1.0.0
keywords: video banao, ভিডিও বানাও, ভিডিও তৈরি, video তৈরি, make a video, create video, reel banao, রিল বানাও, ভিডিও প্ল্যান, video plan, scene video, আমার ছবি দিয়ে ভিডিও, chobi diye video, regenerate scene, S1 abar banao
---

# Media video — plan card → approve → auto render → final video

**Goal:** Boss-এর যেকোনো আইডিয়া থেকে দৃশ্য-ধরে-দৃশ্য AI ভিডিও — `plan_media_video` দিয়ে exact খরচসহ plan card, approve-এর পর অডিও → ছবি → ক্লিপ → ফাইনাল ভিডিও সব নিজে নিজে এই চ্যাটেই।

## ধাপ

1. আইডিয়া থেকে দৃশ্য ভাগ করো (প্রতি দৃশ্য 3-10s): বাংলা VO স্ক্রিপ্ট + rich English imagePrompt/clipBrief। Boss মডেল/ভাষা/দৈর্ঘ্য বললে হুবহু মানো; না বললে ডিফল্ট (ছবি gemini-3-pro-image, ক্লিপ seedance-1.0-pro, ভয়েস "elevenlabs")।
2. Boss নিজের ছবি চাইলে `personalization.useOwnerPhotos: true` দাও, `photoPaths` ফাঁকা রাখো — সার্ভার নিজেই তাঁর রেফারেন্স ছবি নেয়; storage path কখনো অনুমান কোরো না। সেই দৃশ্যগুলোতে `usesOwnerPhoto: true`।
3. `plan_media_video` একবার call করো — card-ই approval; খরচের অঙ্ক নিজে বোলো না, card-এ server-computed exact estimate থাকে।
4. Boss plan বদলাতে চাইলে (মডেল swap, ভাষা, VO বাদ, দৃশ্য যোগ) একই tool আবার call করো **projectId সহ** — card নতুন খরচসহ নিজে বদলে যায়।
5. Approve-এর পর কিছু করার নেই — রেন্ডার চেইন নিজে চলে, প্রতিটা asset রেডি হলে চ্যাটে আসে, শেষে ফাইনাল ভিডিও। প্রগ্রেস জানতে `get_media_project`।
6. ফাইনালের পর Boss "S2 আবার বানাও …" বললে `regenerate_media_scene(projectId, sceneIdx, kind, note)` — শুধু সেই asset নতুন হয়, ফাইনাল ফ্রি-তে re-stitch। ছবি regenerate করলে সেই দৃশ্যের ক্লিপও অটো নতুন হবে (বাড়তি ক্লিপ খরচ) — Boss-কে বলে দাও।

## Guardrails

- এক standalone ছবি/পোস্টার এই skill নয় — alma-image-generation। ক্যাটালগ ছবি থেকে product reel = make_product_reel।
- Approve-এর আগে কোনো generation নেই; asset আসার আগে "হয়ে গেছে" বলা নিষেধ।
- Seedance 2.5 (720p) সবচেয়ে দামি (~$0.47/s) — Boss চাইলে দাও, card-এর অঙ্ক দেখিয়ে।

## Done

`plan_media_video` card stage হয়েছে; approve-এর পর ফাইনাল ভিডিওর worker result চ্যাটে এসেছে — তবেই complete।
