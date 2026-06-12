# PHASE — Telegram Command Menu + Owner Control Panel

**Branch:** `feat/tg-command-menu`  
**Scope:** `worker/src/telegram/*` only (discoverability — no new business logic)

---

## Summary

- All bot commands registered via `setMyCommands()` on startup
- Owner chat: full Bangla menu (17 commands)
- Default scope (staff): safe subset only (4 commands)
- `/menu` inline control panel reuses existing handlers
- `/help` rewritten with grouped Bangla + examples

---

## Full command list (owner)

| Command | Bangla menu description |
|---------|----------------------|
| `/menu` | সব কন্ট্রোল বাটনে দেখুন |
| `/today` | আজকের ব্যবসার সারসংক্ষেপ |
| `/khoroch` | আজ ও এই মাসের খরচ |
| `/pawna` | কে কত পাবে/দেবে |
| `/details` | কারো পুরো হিসাব (নাম লিখুন) |
| `/ask` | এজেন্টকে প্রশ্ন করুন |
| `/cs` | কাস্টমার এজেন্ট চালু/বন্ধ/মোড |
| `/postlink` | FB পোস্টে প্রোডাক্ট লিঙ্ক |
| `/catalog` | ছবি যোগের অগ্রগতি |
| `/group` | ফ্যামিলি ডিজাইন গ্রুপ |
| `/sizechart` | বয়স→সাইজ চার্ট |
| `/new` | নতুন কথোপকথন |
| `/chats` | পুরানো চ্যাট বেছে নিন |
| `/staff` | স্টাফ টেলিগ্রাম লিঙ্ক |
| `/staff_onboard` | স্টাফ GPS অনবোর্ডিং গাইড |
| `/help` | সাহায্য ও উদাহরণ |
| `/start` | বট শুরু করুন |

### `/cs` subcommands (not separate menu entries)

`off`, `shadow`, `night`, `auto`, `status`, `resume <id>`, `followups on|off`, `block <psid>`

### `/catalog` subcommands

`status` (default), `suggest` (owner only)

### `/staff` subcommands

`link <name> <chatId>`

---

## Staff command menu (default scope)

| Command | Bangla description |
|---------|------------------|
| `/catalog` | ছবি যোগের অগ্রগতি |
| `/group` | ফ্যামিলি ডিজাইন গ্রুপ |
| `/help` | স্টাফ সাহায্য |
| `/start` | বট শুরু করুন |

Staff never see finance, CS, `/menu`, or owner agent commands in the "/" picker.

---

## `/menu` panel buttons → handler mapping

| Button | Reuses |
|--------|--------|
| আজকের রিপোর্ট | `handleTodayCommand` (= `/today`) |
| খরচ | `handleKhorochCommand` (= `/khoroch`) |
| পাওনা-দেনা | `handlePawnaCommand` (= `/pawna`) |
| CS Status / Shadow / Auto / বন্ধ | `handleCsStatus` / `handleCsModeCommand` |
| আজকের নামাজ | `handleSalahTodayCommand` (salah slice of `/today` data) |
| ট্র্যাকিং Pause | `agent-settings` `salah_escalation_level` toggle 0↔2 |
| রিমাইন্ডার তালিকা | `agent_reminders` read (same DB as `list_reminders` tool) |
| সব বন্ধ আজ | `reminder-update` snooze until EOD |
| ক্যাটালগ Status | `handleCatalogStatus` (= `/catalog`) |
| Scheduler | `GET /api/assistant/internal/watchdog` |
| Worker health | `GET /api/assistant/internal/health` |
| বিস্তারিত হিসাব | prompts `/details <নাম>` |

---

## Files changed

| File | Change |
|------|--------|
| `worker/src/telegram/commands.mjs` | NEW — `setMyCommands` registry |
| `worker/src/telegram/menu.mjs` | NEW — `/menu` panel + callbacks |
| `worker/src/telegram/help.mjs` | NEW — grouped help text |
| `worker/src/telegram/quick-commands.mjs` | `handleSalahTodayCommand` export |
| `worker/src/telegram/index.mjs` | Wire `/menu`, `/help`, menu callbacks, startup register |

---

## Verification

| Check | Result |
|-------|--------|
| `npm run build` | ✅ (Next.js app) |
| Diff limited to `worker/src/telegram/*` + docs | ✅ |
| Owner "/" menu | Manual — Telegram after worker restart |
| Staff "/" menu | Manual — linked staff chat |
| `/menu` buttons | Manual — each matches command output |

---

## Deploy

Worker restart only (no Vercel migration for this phase):

```bash
pm2 restart agent-worker
```

Owner: type `/` in Telegram — full Bangla list should appear. Type `/menu` — control panel buttons.
