---
name: alma-audience-builder
description: Define a target audience from customer segments/intelligence; creation stays gated.
version: 0.1.0
keywords: audience, অডিয়েন্স, target, টার্গেট, customer segment, segment, কাস্টমার গ্রুপ, retargeting, lookalike, ke target
---

# Audience builder — define the right target

**Goal:** কাস্টমার segment + intelligence থেকে একটা পরিষ্কার টার্গেট audience সংজ্ঞা (কারা, কেন)।
audience আসলে তৈরি/সেভ করা owner-gated।

## ধাপ

1. **Existing (required):** `list_audiences` — এখন কী কী audience আছে (ডুপ্লিকেট এড়াও)।
2. **Segments (required):** `get_customer_segments` + `get_customer_intelligence` — কোন গ্রুপ মূল্যবান/সক্রিয়।
3. **Define (required):** টার্গেট audience-এর সংজ্ঞা — বৈশিষ্ট্য, আকার-ধারণা, কেন এই গ্রুপ, কোন campaign-এ কাজে লাগবে।
4. **Handoff (required):** সংজ্ঞা Boss-কে দাও; তৈরি/সেভ existing owner-gated tool দিয়ে।

## Checklist

- বিদ্যমান audience চেক করা (ডুপ্লিকেট নয়)
- সংজ্ঞা ডেটা-ভিত্তিক (segment/intelligence থেকে)
- তৈরি সরাসরি হয়নি — owner-gated

## Guardrails

- ব্যক্তিগত তথ্য একত্র/রপ্তানি নয়; শুধু বিদ্যমান segment টুল ব্যবহার।
- audience তৈরি existing approval দিয়ে।

## Done

ডেটা-ভিত্তিক audience সংজ্ঞা দেওয়া হয়েছে — তবেই "শেষ"।
