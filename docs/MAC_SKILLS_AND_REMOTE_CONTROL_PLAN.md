# Mac Skills Pack + Phone-Touch Remote Control — Research & Plan (2026-08-03)

মালিকের নির্দেশ: research + plan এখানে; **implementation আলাদা session-এ**।
দুটো আলাদা program — আলাদা branch, আলাদা session, নিচে kickoff message দেওয়া।

---

# PART 1 — Mac Skills Pack (skill engine-এ ১২টা নতুন skill)

## Research ভিত্তি
- বাজারে Mac-automation ব্যবহারকারীরা (Raycast, Apple Shortcuts, Hammerspoon,
  Keyboard Maestro, BetterTouchTool community) সবচেয়ে বেশি যা automate করে:
  file-organizing, screenshot-workflow, window/workspace, media convert, app
  launch-sets, clipboard, system health।
- Desktop-agent জগতে (OpenAI Operator-class, Claude computer-use): নির্ভরযোগ্যতা
  আসে **কাজ-ভিত্তিক playbook** থেকে — generic "computer চালাও" নয়।
- আমাদের নিজের প্রমাণ: L8/P0-তে দেখা গেছে prompt-এ নিয়ম লিখে model বাঁধা যায় না;
  **skill file = সেই কাজের কোডিফাই করা playbook + guard**, engine-এ approval
  ledger আছেই — এটাই সঠিক বাহন।

## Skill তালিকা (অগ্রাধিকার-ক্রমে, প্রতিটির: কী, কেন, কোন tool, ঝুঁকি)

**Tier 1 — এখনই সবচেয়ে বেশি কাজে লাগবে (আগে এগুলো)**

1. **`mac-ai-app-operator`** — ChatGPT/Claude desktop app চালানোর পূর্ণ playbook:
   new-chat (⌘N path — P0-তে প্রমাণিত), session-identity verify, prompt লেখা,
   reply পড়া (fullTree), correction-loop। Tool: look/drive_mac_app। ঝুঁকি: কম
   (সবকিছু approval-card পথে)। *L8-এর সব শেখা এক জায়গায় — সবচেয়ে দামি skill।*
2. **`xcode-testflight-shipper`** — preflight → build-bump commit → pipeline
   dispatch (`ios-testflight.yml`) → ASC poll → owner-report। আজকের build-94
   flow-টাই skill। Tool: run_mac_command + gh। ঝুঁকি: মাঝারি (bump commit) —
   card-gated।
3. **`git-pr-workflow`** — branch/commit/push/PR/Codex-triage/merge-ladder (এই
   session-এর প্রমাণিত勝 recipe)। Tool: run_mac_command। ঝুঁকি: মাঝারি।
4. **`mac-file-organizer`** — Downloads/Desktop পরিষ্কার, নামকরণ-নিয়ম, dedupe,
   size-report; সর্বদা "তালিকা দেখাও → approve → সরাও" — কখনো সরাসরি delete
   (trash-only)। Tool: run_mac_command। ঝুঁকি: বেশি → কঠোর guard skill-এই লেখা।
5. **`screenshot-annotate-share`** — capture (dedicated path!) → crop/arrow/টীকা
   (sips/ImageMagick) → chat/Telegram-এ। Tool: mac_desk_control + শেল। ঝুঁকি: কম।

**Tier 2 — উৎপাদনশীলতা**

6. **`media-transcoder`** — ffmpeg recipe-set: ভিডিও compress/trim/gif, audio
   extract, ছবির bulk-convert (Creative Studio-র পাশে দরকারি)। ঝুঁকি: কম।
7. **`pdf-processor`** — merge/split/extract-text/compress (qpdf, sips,
   textutil)। ব্যবসার দলিল-কাজে সরাসরি লাগবে। ঝুঁকি: কম।
8. **`workspace-launcher`** — নাম-করা app-set: "কাজের মোড" (Chrome+ChatGPT+
   Terminal), "hisab মোড" ইত্যাদি; খোলা+সাজানো (open + AX position)। ঝুঁকি: কম।
9. **`mac-health-monitor`** — disk/battery/memory/process check, বড় ফাইল খোঁজা
   (mdfind/du), daemon-দের অবস্থা; রিপোর্ট Bangla-য়। ঝুঁকি: কম (read-only)।
10. **`spotlight-finder`** — "গত মাসের invoice PDF খোঁজো" শ্রেণির প্রশ্ন →
    mdfind query-craft → ফলাফল + open/share। ঝুঁকি: কম।

**Tier 3 — পরে**

11. **`clipboard-notes-capture`** — clipboard-history → নোট/task-এ রূপ (pbpaste,
    Notes osascript)। 12. **`calendar-reminders-bridge`** — osascript দিয়ে
    event/reminder পড়া-লেখা (card-gated লেখায়)। 13. **`app-installer`** — brew
    install/update, dmg-flow (সর্বদা card)। 14. **`window-arranger`** — AX দিয়ে
    resize/tile। 15. **`login-items-auditor`** — startup-item report।

## Engine-এ বসানোর নিয়ম (নতুন session-এর জন্য)
- প্রতিটি skill = বিদ্যমান skill-engine format (knowledge file + runner binding);
  approval-ledger-এ প্রথম ব্যবহারে owner-approve — আগের নিয়মই।
- **Prompt-এ না, skill-এ guard**: প্রতিটি skill-এ তার নিজের নিষেধ-তালিকা
  (যেমন file-organizer: কখনো `rm`, শুধু trash; installer: কখনো sudo)।
- Manifest + head-prompt-এ নাম তুলতে ভুলো না — "tool আছে অথচ অদৃশ্য" দু'বার
  কামড়েছে (memory: feedback_wire_tools_into_prompt)।
- প্রতি skill-এর শেষে: self-verify ধাপ লেখা থাকবে (কাজের প্রমাণ কী)।
- Rollout: Tier 1 আগে, প্রতিটি live-প্রমাণ সহ; এক PR-এ ২-৩টার বেশি নয়।

---

# PART 2 — ফোন থেকে ছুঁয়ে Mac চালানো (Remote Touch Control)

## সম্ভব? — হ্যাঁ, এবং আমাদের অর্ধেক অবকাঠামো তৈরিই

Downlink (Mac→phone ভিডিও) L9-তে হয়ে গেছে। বাকি শুধু **uplink**: ফোনের স্পর্শ →
Mac-এ mouse/keyboard event। এটাই Screens/Jump Desktop-এর মূল কৌশল — আমরা
নিজেদের app-এর ভেতরে করব।

## Best way (সুপারিশ): Agora Data Stream + CGEvent

```
iOS ভিডিও canvas-এর উপর gesture layer
   tap/drag/scroll/two-finger → normalize (0..1 x,y)
        ↓  Agora sendStreamMessage (একই connection — <100ms, নতুন অবকাঠামো নেই)
ScreenBroadcaster (এখনই channel-এ আছে!)
   receiveStreamMessage → CGEventCreateMouseEvent / CGEventCreateKeyboardEvent
   → CGEventPost  (Accessibility permission daemon-পরিবারের আছেই)
```

কেন এটা best:
- **একই Agora connection** — নতুন server/socket লাগবে না; latency ভিডিওর সমান।
- Broadcaster process-টাই ঘটনাস্থলে আছে (capture + inject এক জায়গায় =
  coordinate-mapping নির্ভুল: frame 1600-wide → display points scale জানা)।
- Owner-only নিরাপত্তা বিনামূল্যে: subscriber token owner-session-gated-ই আছে;
  control-message শুধু ওই channel-এ।

বিকল্প বিবেচিত: (ক) command-bus দিয়ে প্রতি tap → poll-latency-তে অচল; (খ) আলাদা
WebSocket — বাড়তি অবকাঠামো, লাভ নেই; (গ) বাণিজ্যিক remote-desktop app — in-app
অভিজ্ঞতা ও agent-integration হারায়। বাতিল।

## নিরাপত্তা-নকশা (শুরুতেই, পরে জোড়া নয়)
1. **Control আলাদা switch** — দেখা (video) আর ছোঁয়া (control) এক নয়। Sheet-এ
   আলাদা "🖐 কন্ট্রোল" toggle → server-এ control-token (আলাদা claim) → broadcaster
   শুধু তখনই inject করে। Stream বন্ধ = control বন্ধ।
2. **Owner-uid pinning**: broadcaster শুধু সেই uid-র stream-message নেয় যেটা
   token-mint-এ owner টোকেনের সাথে বাঁধা।
3. Rate-limit + sanity (প্রতি সেকেন্ডে সর্বোচ্চ N event, বাউন্ডের বাইরে drop)।
4. Kill-switch/রেড STOP → inject তাৎক্ষণিক বন্ধ (বিদ্যমান পথ)।
5. Audit: control-session start/stop + event-count log (প্রতিটি tap নয়)।

## Phase ভাগ (নতুন session-এর roadmap)
- **RC-1 (core):** tap, double-tap, drag, scroll → CGEvent; iOS gesture layer;
  control-toggle + token; coordinate mapping। প্রমাণ: sim থেকে Mac-এ Finder
  চালানো ভিডিওতে দেখা।
- **RC-2 (keyboard):** on-screen text bar → typeUnicode-শ্রেণির inject; ⌘C/⌘V/
  Enter/Esc শortcut-বার; long-press = right-click।
- **RC-3 (polish):** canvas pinch-zoom/pan (বড় স্ক্রিনে নিখুঁত tap-এর জন্য
  অপরিহার্য), haptics, multi-display বাছাই, connection-drop auto-heal।
- সব শেষে: sim-এ মালিকের নিজের verify → তবেই TestFlight (নিয়ম বহাল)।

জানা ফাঁদ (L9 থেকে): frameworks binary-র পাশে; extend≠respawn; NV12 format;
per-join generation — নতুন session আগে `project_l9_live_video` memory পড়বে।

---

# নতুন session-এর KICKOFF MESSAGE (কপি-পেস্ট)

## Session A — Skills pack:
```
docs/MAC_SKILLS_AND_REMOTE_CONTROL_PLAN.md er PART 1 poro. Memory:
project_skill_architecture ar feedback_wire_tools_into_prompt poro.
Tier 1-er 5 ta skill diye shuru koro — ek PR-e 2-3 tar beshi na, protita
live-proof soho. Kono kichu implement korar age amake Tier-1 order confirm
korte dio.
```

## Session B — Remote touch control:
```
docs/MAC_SKILLS_AND_REMOTE_CONTROL_PLAN.md er PART 2 poro. Memory:
project_l9_live_video (deploy-trap gulo joruri) ar project_l8_head_protocol
poro. RC-1 diye shuru: Agora data-stream → CGEvent inject + iOS gesture
layer + control-toggle/token. Shuru korar age amake nirapotta-nokshar
(control switch, uid-pinning) ek paragraph summary daw, ami go bolle kaj
dhorbe. Sim proof → amar nijer check → tarpor TestFlight — niyom age-r moto.
```
