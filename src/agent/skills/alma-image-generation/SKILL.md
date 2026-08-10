---
name: alma-image-generation
description: Creates new standalone images, posters, illustrations, and visual variations through the existing owner-approved image generation pipeline.
version: 1.0.0
keywords: generate image, create image, make image, design poster, image variation, visual variation, poster, ছবি বানাও, ছবি তৈরি, পোস্টার বানাও, ইমেজ জেনারেট, ডিজাইন করো
---

# Image generation — approval card, render, same-chat result

**Goal:** Boss যে নতুন ছবি, poster, illustration বা visual variation চেয়েছেন সেটি existing
`generate_image` pipeline-এ stage করা; prose দিয়ে permission চাওয়া নয়।

## ধাপ

1. Prompt থেকে subject, style, exact visible text, aspect ratio এবং single-vs-variation count নাও; যা স্পষ্ট আছে তা আবার জিজ্ঞেস কোরো না।
2. `generate_image` একবার call করো। সাধারণ creative-এ `quality: "standard"`; face/product fidelity explicitly চাইলে `quality: "pro"`। Prompt-এ ratio থাকলে `aspectRatio` ঠিকভাবে দাও। একাধিক variation চাইলে একই call-এ `count` দাও (সর্বোচ্চ ৪)—একটাই approval card হবে।
3. Tool যে pending action card দেয় সেটিই approval; আলাদা ask-user বা prose permission card বানাবে না। Card stage হওয়ার পর থামবে—approve না হওয়া পর্যন্ত generated বলবে না।
4. Approval-এর পর worker result একই conversation-এ `file_ref` image হিসেবে আসে। Result না আসা পর্যন্ত progress সত্য রাখবে; failure হলে existing retry path ব্যবহার করবে এবং chat state হারাবে না।

## Multiple variations

- Boss একাধিক variation চাইলে সংখ্যাটি prompt-এ স্পষ্ট রেখে এক approval-এ `count` দাও; একসাথে অনেক pending card বানাবে না।
- Generated `file_ref` blocks একই assistant result-এ এলে native app shared swipe viewer-এ gallery দেখায়।

## Guardrails

- `run_health_scan`, incident diagnosis, web research বা Mac/browser skill এই কাজের অংশ নয়।
- Exact text চাইলে prompt-এ উদ্ধৃত text verbatim রাখো; image model text accuracy নিশ্চিত না হলে মিথ্যা guarantee দিও না।
- Product/মানুষের পরিচয় ধরে রাখতে reference লাগলে real storage path ছাড়া বানাবে না।

## Done

`generate_image` approval card stage হয়েছে; approve-এর পর actual image block conversation-এ এসেছে—তবেই generated result complete।
