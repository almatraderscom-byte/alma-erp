---
name: alma-audience-builder
description: Defines WHO an ad should reach, from our own segment data — which group, how many, why them. Use when Boss asks who to target. It defines only; it holds no tool that creates or exports an audience.
version: 1.0.0
keywords: audience, অডিয়েন্স, ke target korbo, কাকে টার্গেট, target group, customer segment, segment, কাস্টমার গ্রুপ, retargeting, lookalike
---

# Audience builder — who, and why them

**Goal:** নিজেদের কাস্টমার ডেটা থেকে একটা পরিষ্কার টার্গেট গ্রুপের সংজ্ঞা — **কারা, কেন তারা, কতজন**।
এই skill শুধু সংজ্ঞা দেয়; তৈরি/এক্সপোর্ট করার কোনো টুল এর হাতে নেই।

## ধাপ

1. **Existing (required):** `list_audiences` — এখন কী কী আছে। কাছাকাছি কিছু থাকলে নতুন বানানোর আগে সেটা দেখাও।
2. **Segments (required):** `get_customer_segments` + `get_customer_intelligence` — কোন গ্রুপ আসলে দামি/সক্রিয়।
3. **Define (required):** কারা (বৈশিষ্ট্য) · কেন এই গ্রুপ (ডেটা থেকে) · আনুমানিক আকার · কোন ক্যাম্পেইনের জন্য।
4. **Handoff (required):** সংজ্ঞা Boss-কে দাও। তৈরি করা আলাদা কাজ — সেটা ক্যাম্পেইনের owner-gated ধাপে।

## Checklist

- বিদ্যমান audience দেখা হয়েছে (ডুপ্লিকেট নয়)
- প্রতিটা বৈশিষ্ট্য segment/intelligence টুলের ফলাফল থেকে — বানানো নয়
- আকারের অনুমান বলা হয়েছে "অনুমান" হিসেবেই
- কোনো ব্যক্তিগত তালিকা বের করা হয়নি

## Guardrails

- গ্রুপের সংজ্ঞা, ব্যক্তির তালিকা নয় — নাম/ফোন/ঠিকানা একত্র বা রপ্তানি করবে না।
- ডেটা যা দেখায়নি এমন কারণ লিখবে না ("এরা প্রিমিয়াম পছন্দ করে" — কোথা থেকে?)।

## Done

ডেটা-ভিত্তিক সংজ্ঞা + বিদ্যমান audience-এর সাথে মিল/অমিল Boss-কে দেওয়া হয়েছে — তবেই "শেষ"।
