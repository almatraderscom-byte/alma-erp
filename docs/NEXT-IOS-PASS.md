# NEXT — the iOS pass (owner's own words, 2026-07-27)

**Do NOT start this until every web fix in roadmap-1 is finished AND the owner
has said "হ্যাঁ" to starting iOS.** Read `docs/HANDOFF.md` §7 (flags) first.

Owner's instruction, verbatim:

> এই সেশনের সব বাকি কাজ শেষ করার পর iOS নিয়ে একটা ধাপ আছে — আগে
> docs/HANDOFF.md এর ৭ নম্বর অংশ পড়ে নাও।
>
> ক্রম যেভাবে চাই:
>
> ১. আগে এই সেশনের সব ভাঙা জিনিস শেষ করো (duplicate guard + ভুয়া দাবি,
>    কার্ডের অবস্থা অনুমান করা, non-stop কাজ) — প্রতিটার পর আমার Chrome-এ
>    লাইভ প্রমাণ।
>
> ২. সব শেষ হলে থামবে আর আমাকে জিজ্ঞেস করবে — নিজে থেকে iOS-এ হাত
>    দেবে না।
>
> ৩. আমি "হ্যাঁ" বললে তখন iOS এর সব কাজ একসাথে করবে, ফোঁটা ফোঁটা নয়।
>    এই তিনটা অবশ্যই থাকবে (আগের সেশনে ওয়েবে হয়েছে, নেটিভে হয়নি):
>
>    ক) skill_pinned ইভেন্ট নেটিভে হ্যান্ডেল করা — ios/App/App/
>       AssistantTransport.swift এ ওটা একেবারেই নেই, তাই ফোনে
>       "🧠 <skill> ব্যবহার করছি" লাইনটা দেখায় না
>    খ) মেসেজ পাঠানোর সাথে সাথেই Process/thinking অংশ খোলা থাকা
>       (এখন কয়েক সেকেন্ড ফাঁকা থাকে)
>    গ) Approve চাপার সাথে সাথেই লোডার + worker-এ চলা কাজের লাইভ চিন্তা
>
>    এর সাথে এই সেশনে তুমি যা যা করেছ তার নেটিভ অংশও একই পাসে নেবে।
>
> ৪. তারপর সিমুলেটরে (iPhone 17 Pro Max) নিজে চালিয়ে যাচাই করবে আর
>    আমাকে স্ক্রিনশট দেখাবে — শুধু build পাস করা প্রমাণ নয়।
>
> ৫. আমি স্ক্রিনশট দেখে confirm করলে তবেই TestFlight বিল্ড, তার আগে নয়।
>    বিল্ডের আগে scripts/ios-build-preflight.sh চালাবে।
>
> আমাকে বাংলায় উত্তর দেবে। main-এ merge করবে না।

## Gate checklist for that pass

- [ ] All roadmap-1 web fixes done and live-proven in his Chrome
- [ ] Owner asked and said yes
- [ ] ONE pass, batched — not a drip of small builds
- [ ] Simulator (iPhone 17 Pro Max) screenshots, not just a green build
- [ ] Owner confirms the screenshots
- [ ] `bash scripts/ios-build-preflight.sh` before Archive
- [ ] Never merge to main
