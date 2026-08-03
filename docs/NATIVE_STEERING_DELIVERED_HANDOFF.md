# Handoff — "এজেন্ট পড়ে ফেলেছে" চিহ্ন (native iOS চ্যাট)

**কে পড়বে:** যে session পরের TestFlight build বানাবে। এটা একটা ছোট, স্বয়ংসম্পূর্ণ
কাজ — **নিজের কাজের সাথে মিশিয়ে একটাই build-এ পাঠাতে হবে**, এর জন্য আলাদা build নয়।

**মালিকের কথা (২০২৬-০৮-০৩):** ফোনে দেখা যায় "পাঠানো হয়েছে", কিন্তু **এজেন্ট সেটা
আসলে পড়েছে কিনা** আলাদা করে বোঝা যায় না। ওয়েবে এটা আছে; ফোনে নেই।

---

## ১. এটা বাগ নয় — অর্ধেক তৈরি ফিচার

সার্ভার-দিক **পুরো তৈরি ও production-এ চলছে**। native app শুধু নতুন ইভেন্টটা
এখনো চেনে না, তাই `.unknown` হিসেবে ফেলে দেয়।

দুইটা অবস্থা আলাদা, আর এখন ফোনে দুইটাই একরকম দেখায়:

| অবস্থা | মানে | ফোনে এখন |
|---|---|---|
| `accepted` | **সার্ভার** মেসেজটা জমা রেখেছে (`/steer` 2xx) | ✅ "পাঠানো হয়েছে" |
| **delivered** | **চলমান turn সেটা পড়ে ফেলেছে** (মডেলের কাছে গেছে) | ❌ কিছুই না |

---

## ২. সার্ভার যা ইতিমধ্যে পাঠায়

### SSE ইভেন্ট — `steering_delivered`

```jsonc
{ "type": "steering_delivered",
  "ids": ["<AgentMessage row id>", ...],
  "clientMessageIds": ["<client uuid>", ...] }   // ← এটাই মেলানোর চাবি
```

- সংজ্ঞা: `src/agent/lib/core.ts` (`AgentEvent` union, `steering_delivered`)
- **চারটা জায়গা থেকে** emit হয় (একটা মিস করলে ক্লায়েন্ট ভাববে পৌঁছায়নি):
  - `src/agent/lib/models/run-owner-turn.ts` — round-শুরুর claim, আর final-draft
    (late) claim
  - `src/agent/lib/core.ts` — native Anthropic loop-এর দুইটা claim
- SSE route সব ইভেন্ট generic ভাবে পাঠায় (`/api/assistant/chat`), তাই
  সার্ভারে **আর কিছু করার নেই**।

### Reload-এর পর মেলানোর জন্য GET

```
GET /api/assistant/turn/<turnId>/steer?clientMessageId=<uuid>
→ { "status": "consumed" | "queued" | "unknown", "messageId": "...", "turnId": "..." }
```

`src/app/api/assistant/turn/[id]/steer/route.ts` — owner-gated, read-only।
**কেন লাগে:** `/steer`-এর 2xx মানে সার্ভার **রেখেছে**, **পড়েছে নয়**। turn যদি ঠিক
তার পরেই ব্যর্থ হয়, কেউ কখনো পড়বে না। তাই cold start-এ আন্দাজ না করে জিজ্ঞেস করো।

---

## ৩. ওয়েবে কী করা হয়েছে (নকল করার মতো নমুনা)

- `src/agent/components/AgentThread.tsx` — `ChatMessage.delivery?: 'queued' | 'delivered' | 'failed'`,
  আর bubble-এর নিচে চিপ। **`delivered` অবস্থায় কিছুই আঁকা হয় না** — প্রতিটা
  bubble-এ স্থায়ী টিক শুধু কোলাহল।
- `src/agent/components/AgentApp.tsx` — ইভেন্ট এলে state বদলায় + outbox থেকে বাদ।
- `src/agent/lib/steering-outbox.ts` — localStorage outbox, `accepted` পতাকা,
  `applyServerStatus()` (reload-এর পর মেলানো), backoff।

চিপের লেখা (ওয়েবে যা আছে): **"চলতি কাজে যোগ হয়েছে — এজেন্টের কাছে পৌঁছায়নি এখনো"**

---

## ৪. native-এ ঠিক কী করতে হবে

### ৪.১ transport — ইভেন্টটা decode করো

`ios/App/App/AssistantTransport.swift`

1. wire struct-এ (যেখানে `let skill: String?` ইত্যাদি আছে, ~line 131) যোগ করো:
   ```swift
   let clientMessageIds: [String]?   // steering_delivered
   let ids: [String]?                // steering_delivered
   ```
2. `AgentTurnEvent` enum-এ (~line 141) যোগ করো:
   ```swift
   /// একটা মেসেজ চলমান turn আসলে পড়ে ফেলেছে — "সার্ভার নিয়েছে"-র পরের ধাপ।
   case steeringDelivered(clientMessageIds: [String])
   ```
3. switch-এ (`case "skill_pinned":`-এর পাশে, ~line 231) যোগ করো:
   ```swift
   case "steering_delivered":
       self = .steeringDelivered(clientMessageIds: ev.clientMessageIds ?? [])
   ```

> `.unknown` কেসটা ইচ্ছে করেই আছে — protocol drift যেন চুপচাপ হারিয়ে না যায়।
> তাই decode যোগ না করা পর্যন্ত ইভেন্টটা টেলিমেট্রিতে `unknown` হয়ে যাচ্ছে।

### ৪.২ state — নতুন একটা অবস্থা

`ios/App/App/AssistantSwiftUI.swift`

- `AgentChatMessage.OutgoingState` (~line 787) — `case delivered` যোগ করো
  (`accepted`-এর পরে)।
- label (~line 8347): `case .delivered: return "এজেন্ট পড়েছে"`
- icon (~line 8359): `case .delivered: return "checkmark.circle.fill"`
  (`accepted` = `checkmark`, তাই দুইটা আলাদা করে বোঝা যায়)
- ইভেন্ট handler-এ (যেখানে `.skillPinned` handle হয়) :
  ```swift
  case .steeringDelivered(let ids):
      let set = Set(ids)
      for i in messages.indices where messages[i].clientMessageId.map(set.contains) == true {
          messages[i].outgoingState = .delivered
      }
      queuedOwnerMessages.removeAll { set.contains($0.id) }
  ```

### ৪.৩ cold start — আন্দাজ নয়, জিজ্ঞেস

অ্যাপ খুলে যদি local queue-তে `accepted` কিছু পড়ে থাকে, উপরের **GET**-টা মেরে
দেখো: `consumed` → `.delivered` + queue থেকে বাদ · `queued` → যেমন আছে · অফলাইন →
কিছুই বদলিয়ো না (নিরাপদ অবস্থা)।

### ৪.৪ যা করবে না

- **`accepted` অবস্থাটা মুছে ফেলবে না** — ওটা এখনো সত্যি একটা ধাপ।
- **`.delivered`-এ আলাদা কোনো ব্যানার/টোস্ট নয়** — শুধু ওই বার্তার চিহ্ন।
- **native drain/queue যুক্তি বদলাবে না** — ওটা ঠিক আছে (409-এ bubble মোছে না,
  turn শেষ হলে নিজেই নতুন turn বানায়)। এটা **শুধু দৃশ্যমানতা**।

---

## ৫. যাচাই (build-এর আগে)

1. `npm run type-check` + `npx vitest run src/agent/lib/skill-engine` — সার্ভার
   দিক অক্ষত আছে কিনা (এই কাজে সার্ভারে হাত দেওয়ার দরকার নেই)।
2. **Simulator-এ live**: একটা লম্বা কাজ শুরু করো, চলাকালীন দ্বিতীয় মেসেজ পাঠাও —
   প্রথমে "পাঠানো হয়েছে", এজেন্ট তুলে নিলেই **"এজেন্ট পড়েছে"**। স্ক্রিনশট নাও।
   (`xcrun simctl` + `mac_desk_control` screenshot — bundle id **`com.almatraders.erp`**)
3. মালিকের নিয়ম: **TestFlight build-এর আগে তাঁকে প্রমাণ দেখিয়ে অনুমতি নিতে হবে**,
   আর `bash scripts/ios-build-preflight.sh` পাশ করতে হবে (clean tree, pushed,
   main-current)। build নম্বর bump = আলাদা commit, push করে তারপর upload।

---

## ৬. এক লাইনে

সার্ভার ইতিমধ্যে বলে দিচ্ছে "এজেন্ট পড়েছে"; ফোনে শুধু **শুনতে শেখাতে হবে** —
একটা enum কেস, একটা switch শাখা, একটা label/icon, আর cold-start-এ একটা GET।
