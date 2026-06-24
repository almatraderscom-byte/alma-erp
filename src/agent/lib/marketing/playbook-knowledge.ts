/**
 * Marketing playbook knowledge — distilled, retail-relevant subset of public
 * marketing-psychology + copywriting skills, adapted to ALMA Lifestyle's reality
 * (Bangladeshi fashion/lifestyle, Facebook + Messenger commerce, Bangla customers).
 *
 * Deliberately TOKEN-SAFE: this is NOT injected into the head agent's (already large)
 * system prompt. It is appended only to the `marketer` and `content` specialist
 * sub-agent briefs (specialist-roles.ts), so it loads ONLY when a marketing/content
 * sub-task actually runs — zero standing cost on the owner-facing head.
 *
 * Source skills (public): coreyhaines31/marketingskills (marketing-psychology,
 * copywriting). Full lists were filtered down to the ~16 B2C-retail principles that
 * apply to a Facebook-commerce fashion shop; SaaS/B2B items (cold-email, paywalls,
 * onboarding, network-effects, enterprise-tier pricing, etc.) were intentionally dropped.
 *
 * Pure data module — no imports, safe to import anywhere.
 */

/** ~16 retail-relevant behavioural principles, one compact Bangla line each. */
export const MARKETING_PSYCHOLOGY_BN = `মার্কেটিং সাইকোলজি (রিটেইল — শুধু সত্য হলে ব্যবহার করো):
১. সোশ্যাল প্রুফ: রিভিউ, কাস্টমারের ছবি, "এ পর্যন্ত X জন নিয়েছেন" দেখাও।
২. সত্যিকার আর্জেন্সি/স্কারসিটি: সীমিত স্টক বা টাইম-অফার — কেবল সত্যি হলে, কখনো বানানো নয়।
৩. অ্যাঙ্করিং: আগের দাম কেটে নতুন দাম দেখাও, যাতে ছাড়টা স্পষ্ট হয়।
৪. ডিকয়/Good-Better-Best: ৩টা অপশন দাও, মাঝেরটাকে টার্গেট বানাও।
৫. চার্ম প্রাইসিং: ভ্যালু পণ্যে ৳৪৯৯ ধরনের; প্রিমিয়ামে রাউন্ড দাম (৳৫০০০)।
৬. রুল অফ ১০০: ৳১০০-র নিচে শতকরা ছাড় (২০%) বড় দেখায়, উপরে টাকার ছাড় (৳৫০০) বড় দেখায়।
৭. লস অ্যাভার্সন + ফ্রেমিং: "মিস করবেন না" — পাওয়ার বদলে হারানোর কথা মনে করাও; এক তথ্য পজিটিভভাবে বলো।
৮. মিয়ার এক্সপোজার: ব্র্যান্ডের নিয়মিত, একই রকম উপস্থিতি বারবার দেখা গেলে পছন্দ বাড়ে।
৯. পিক-এন্ড: ডেলিভারি/আনবক্সিং অভিজ্ঞতা স্মরণীয় করো — শেষ ছাপটাই বেশি মনে থাকে।
১০. কন্ট্রাস্ট (before/after): ফ্যাশনে আগে-পরে দেখানো খুব কার্যকর।
১১. রেসিপ্রোসিটি: ছোট গিফট/ফ্রি ডেলিভারি/টিপস আগে দাও — মানুষ ফিরিয়ে দিতে চায়।
১২. মেন্টাল অ্যাকাউন্টিং: বড় দামকে ছোট করে দেখাও — "দিনে মাত্র X টাকা"।
১৩. প্যারাডক্স অফ চয়েস / Hick's Law: কম অপশন, একটাই পরিষ্কার CTA — সিদ্ধান্ত সহজ করো।
১৪. গোল-গ্রেডিয়েন্ট / Zeigarnik: "আর একটু বাকি", অসম্পূর্ণ কার্ট মনে করানো — শেষ করার তাড়না তৈরি করে।
১৫. AIDA + Rule of 7: Attention→Interest→Desire→Action; কনভার্ট হওয়ার আগে ~৭ বার রিটার্গেট ধরে রাখো।
১৬. অথরিটি/লাইকিং: পরিচিত মুখ, কমিউনিটির ভাষা ("আপনার জন্য") আস্থা বাড়ায়।`

/** Copywriting rules + CTA/headline/structure formulas, Bangla-adapted. */
export const COPYWRITING_RULES_BN = `কপিরাইটিং নিয়ম (বাংলায়):
• স্পষ্টতা > চালাকি। সহজ শব্দ, এক সেকশনে এক আইডিয়া।
• ফিচার নয়, বেনিফিট — পণ্যটা কাস্টমারের জীবনে কী বদলায় সেটা বলো।
• নির্দিষ্ট হও: "ভালো মান" নয় → "১০০% সুতি, ২–৩ দিনে হোম ডেলিভারি"।
• কাস্টমার যে ভাষায় কথা বলে সেভাবেই লেখো; সক্রিয় ও আত্মবিশ্বাসী টোন, "প্রায়/খুব" বাদ।
• দুর্বল CTA এড়াও ("সাবমিট/আরও জানুন") → শক্ত CTA: "অর্ডার করুন", "এখনই কিনুন", "ইনবক্সে দাম জানুন"।
• হেডলাইন ফর্মুলা: "{ব্যথা} ছাড়াই {ফল}" · "{অডিয়েন্স}-এর জন্য {ক্যাটাগরি}" · "আর কখনো {সমস্যা} নয়"।
• পোস্ট/পেজ কাঠামো: হুক → সমস্যা → সমাধান(বেনিফিট) → সোশ্যাল প্রুফ → অফার/দাম → পরিষ্কার CTA।
• সততা: মিথ্যা স্কারসিটি, ভুয়া রিভিউ বা বানানো পরিসংখ্যান কখনো নয়।`

/** Combined brief fragment appended to the `marketer` specialist role. */
export const MARKETER_KNOWLEDGE_BRIEF = `\n\n--- মার্কেটিং নলেজ (কাজে লাগলে ব্যবহার করো, halal থাকো) ---\n${MARKETING_PSYCHOLOGY_BN}\n\n${COPYWRITING_RULES_BN}`

/** Lighter fragment for the `content` specialist — copy craft focus. */
export const CONTENT_KNOWLEDGE_BRIEF = `\n\n--- কপি ও কনভার্সন নলেজ (কাজে লাগলে ব্যবহার করো, halal থাকো) ---\n${COPYWRITING_RULES_BN}`
