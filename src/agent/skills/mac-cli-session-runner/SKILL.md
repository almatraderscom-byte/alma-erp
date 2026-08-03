---
name: mac-cli-session-runner
description: Runs a Claude or Codex coding session on Boss's own Mac from chat — opens it, sends the task, watches the progress, relays questions to him in Bangla and his answers back, and stops it when the work is done. Use when Boss wants code work done on his Mac while he is away from it.
version: 1.0.0
keywords: claude session kholo, codex session, cli session, mac e claude, code kaj koro mac e, session chalao, oke bolo code
---

# Boss-এর Mac-এ Claude/Codex সেশন চালানো

Boss ফোনে, কাজটা তাঁর Mac-এ। তুমি সেশন খোলো, কাজ বুঝিয়ে দাও, অগ্রগতি দেখো, আর
**বাংলায় সারসংক্ষেপ** করে বলো। কাঁচা event ঢেলে দেওয়া নিষিদ্ধ।

## permission mode — এটাই সবচেয়ে বড় সিদ্ধান্ত

| mode | কী পারে | কখন |
|---|---|---|
| **plan** (ডিফল্ট) | শুধু দেখে ও পরিকল্পনা দেয় | **সবসময় এখান থেকেই শুরু** |
| **acceptEdits** | ফাইল সত্যিই বদলায় | Boss কাজটা করতে বললে |
| **bypass** | সব নিজে | **নিজে থেকে কখনো নয়** — Boss স্পষ্ট করে "নিজে থেকেই সব করুক" বললে তবেই, আর ওটা কার্ড হয়ে যায় |

## ধাপ

```
- [ ] ১. Mac অনলাইন? আগে থেকে সেশন চলছে?
- [ ] ২. সেশন খোলো (plan mode) — sessionId মনে রাখো
- [ ] ৩. কাজটা এক বার্তায় স্পষ্ট করে দাও
- [ ] ৪. lastSeq ধরে অগ্রগতি পড়ো, বাংলায় বলো
- [ ] ৫. প্রশ্ন এলে Boss-কে জিজ্ঞেস করো, উত্তর ফেরত পাঠাও
- [ ] ৬. শেষ হলে থামাও, কী হলো বলো
```

১. `mac_agent_status`, তারপর `list_cli_sessions` — **একই কাজের জন্য দ্বিতীয় সেশন
   খুলো না**; আগেরটা থাকলে সেটাতেই কাজ করো।
২. `start_cli_session` — `permissionMode: "plan"`। ফেরত পাওয়া **`sessionId`
   প্রতিটা পরের কলে লাগবে**।
৩. কাজের বার্তা: কী করতে হবে, কোন ফাইল/ফোল্ডার, আর **কী করা যাবে না**।
   অস্পষ্ট কাজ পাঠিও না — সেশন তখন প্রশ্ন করতে করতে সময় নষ্ট করে।
৪. `read_cli_session` আগের `lastSeq` দিয়ে। **প্রতিবার Boss-কে দুই লাইন**: এখন কী
   করছে, আর কতদূর। একই কথা বারবার বোলো না।
৫. সেশন কিছু জিজ্ঞেস করলে **সেটা Boss-এর প্রশ্ন** — তুমি উত্তর বানাবে না।
   তাঁর উত্তর `send_to_cli_session` দিয়ে হুবহু পাঠাও।
৬. `stop_cli_session` — কাজ শেষ হলে বা Boss থামাতে বললে। **সেশন খোলা রেখে চলে
   যেয়ো না**, ওটা তাঁর Mac-এ চলতেই থাকে।

## যেসব উত্তর ব্যর্থতা নয়

- **not_logged_in** — Boss-কে বলো: Mac-এ Terminal খুলে একবার `claude` লিখে
  `/login` করতে হবে। এটা তুমি করতে পারবে না, আর চেষ্টাও কোরো না।
- **সেশন চুপ** — কিছুক্ষণ পরে আবার পড়ো। ২০ মিনিট নীরব থাকলে Boss-কে জানাও।

## এই skill-এর নিজের নিষেধ

- **bypass নিজে থেকে নয়।**
- **সেশনের প্রশ্নের উত্তর নিজে দেওয়া নয়** — ওটা Boss-এর সিদ্ধান্ত।
- **টাকা খরচ/publish করে এমন কাজ সেশনকে দেওয়া নয়** — সেগুলো কার্ডের পথে যায়।
- **কাঁচা event/লগ ঢেলে দেওয়া নয়** — বাংলায় সারসংক্ষেপ।
- **"হয়ে গেছে" নয় যতক্ষণ না সেশনের নিজের আউটপুটে সেটা দেখা যাচ্ছে।**

## Boss-কে কী বলবে

শেষে চার লাইন: **কোন সেশন · কোন mode · কী কী বদলেছে · কী বাকি**। কিছু আটকে থাকলে
সেটাই প্রথমে।
