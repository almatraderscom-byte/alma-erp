# ALMA iOS — Session Handoff (2026‑07‑07)

Read this top‑to‑bottom before touching anything. It captures everything the previous
session did/learned so you can start cold. **Reply to the owner (Maruf) in Bangla; he is a
non‑engineer business owner. Address him "Boss"/"Sir".**

---

## 0. IMMEDIATE NEXT TASKS (priority order)

1. **Fix 2 bugs reported in build 50, Order section** (they ship in the NEXT build — see §3):
   - **Multi‑order add is broken:** in the native new‑order form, adding a *second* product
     (the **"আরেকটা পণ্য যোগ করুন"** button / the multi‑item flow) doesn't work.
   - **Price shows the real/buying price:** when a product is picked, the price field is
     pre‑filled with the *buying* price instead of the default *sell* price.
2. **Continue the approved Office redesign** on branch `office-native` (see §4). The design is
   already APPROVED by the owner via interactive HTML demos — implement it faithfully in SwiftUI.
3. Coordinate builds with the parallel `native/dashboard` session (see §1) — never two uploads at once.

---

## 1. BRANCH TOPOLOGY & MULTI‑SESSION COORDINATION (CRITICAL — read first)

Multiple Claude sessions work this repo at once, each in its own git worktree/branch. A
sim/TestFlight build reflects ONLY its own worktree — nothing merges until branches are
committed + merged, then ONE build is made. Two independent builds clobber each other on
TestFlight (one app, one build slot).

| Branch | What's on it | State |
|---|---|---|
| `native/voice-console` | **Build 50 (shipped)** — done work only: product‑images native, order form + size system, keyboard dismiss, More‑page aura. Office reverted to pristine. | pushed to origin |
| `office-native` | **The Office redesign WIP** — role‑based boss hub + intercom + `/api/assistant/office/hub` route + AlmaAPI multipart + the native‑polish redesign in progress. | pushed to origin |
| `native/dashboard` | **ANOTHER live session's Dashboard work.** Uncommitted at handoff time. | not yours — do not clobber |

- Build 50 was cut from `native/voice-console` on top of `main`/history at commit `aa57425d` (build 49).
- The office was deliberately split OUT of build 50 to avoid conflicting with `native/dashboard`.
- **Where fixes go:** the 2 order bugs (§3) are in the shipped order form → fix on the branch that
  will be built next (likely rebased on `native/voice-console`), and also carry to `office-native`.
  The office redesign continues on `office-native`.
- Owner's phrase to remember: *"native/dashboard session e kaj coltese"* — they'll rebase on
  build 50 and cut the next build. Don't upload while they might.

---

## 2. TESTFLIGHT BUILD RECIPE (works from THIS Mac — don't waste time hunting)

The previous session almost missed this. **Builds 33–50 are done from this same Mac.** Upload
uses the **Apple ID session already signed into Xcode's keychain** — NO auth‑key flags needed;
`-allowProvisioningUpdates` handles distribution signing.

```bash
# 1. bump build number in 4 places
cd <worktree>
sed -i '' 's/CURRENT_PROJECT_VERSION = 50;/CURRENT_PROJECT_VERSION = 51;/g' ios/App/App.xcodeproj/project.pbxproj
git add ios/App/App.xcodeproj/project.pbxproj && git commit -m "chore(ios): bump build 51"

# 2. archive (Release, generic iOS)
cd ios/App
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath /tmp/alma51.xcarchive \
  -allowProvisioningUpdates archive        # → ** ARCHIVE SUCCEEDED **

# 3. export + upload (plist below)
xcodebuild -exportArchive -archivePath /tmp/alma51.xcarchive -exportPath /tmp/alma51-export \
  -exportOptionsPlist /tmp/alma-export-opts.plist -allowProvisioningUpdates
#   → look for "Progress 100%: Upload succeeded." + ** EXPORT SUCCEEDED **
```

`/tmp/alma-export-opts.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><true/>
  <key>teamID</key><string>5D9FLR3MMA</string>
</dict></plist>
```

- **`-exportPath` stays EMPTY on `destination:upload`** → a trailing `ls` gives exit 1. Ignore it;
  trust the **"Upload succeeded"** log line (and the distribution record shows `errors=()`).
- Identifiers: app id `6786929629`, team `5D9FLR3MMA`, keyID `T875C2865Y`, issuer
  `4ea79058-88d0-4dbc-9010-78cf543b1790`, ASC key at `~/.appstoreconnect/private_keys/AuthKey_T875C2865Y.p8`
  (**NOT** the Documents/ALMA‑secrets path — that doesn't exist here). Auth‑key flags are only for
  VALID‑state API polling, not the upload.
- **Rolling 24h upload limit — one upload per batch.** Apple's internal‑distribution processing can
  lag 1–2h; you can't force it (POST to betaGroups returns 422). Owner checks TestFlight on his phone.
- Full recipe also in `docs/ios-native-frame-handoff.md` §"TestFlight (cloud‑signing)".

---

## 3. BUILD 50 — what shipped + the 2 order bugs to fix

**Shipped & verified (done, don't redo):** product‑images native (upload/delete/auto‑resign of
expired Supabase signed URLs — server fix in `src/agent/lib/catalog/product-images.ts` + native
`CatalogImagesSwiftUI.swift`); Orders count/chip sync (`OrdersSwiftUI.swift` — derive counts from
the actual list, not `summary` which counts archived rows); order form + **web‑parity size system**
(`OrderCreateSwiftUI.swift` — MEN numeric 16–54 → KIDS/ADULT pools, WOMEN variant groups; ported
from `src/components/orders/new-order/collection-engine.ts`); keyboard tap‑to‑dismiss
(`KeyboardDismiss.swift`, window‑level recognizer that ignores controls/text fields); More‑page
aura (`MoreMenuSwiftUI.swift`).

**BUG 1 — multi‑order add broken.** In `OrderCreateSwiftUI.swift`, `itemsCard` has an
"আরেকটা পণ্য যোগ করুন" button that only does `query = ""; pickingGroup = nil`. Reproduce: add one
item, tap it, try to add a second. Verify the search field + `groupResults` reappear and a second
`FormItem` can be appended. Likely the search field is gated behind `if items.isEmpty` somewhere,
or the picker doesn't re‑show. Fix so multiple items work end‑to‑end (the payload already supports
`items[]`).

**BUG 2 — price = buying price.** In `appendItem(...)`:
`let price = priceBySku[stock.sku ?? ""] ?? priceBySku[group.key] ?? stock.buyingPrice ?? 0`.
`priceBySku` is built from `/api/products` `defaultPrice` keyed by product `sku`. The STOCK sku is
like `133-ADULT` while the product sku/collection is `133`, so the lookup misses and it falls back
to **`stock.buyingPrice` (the real/buying price)** — that's what the owner sees. Fix: key
`priceBySku` by collection code AND product sku/name, look up by `group.key` (collection) first, and
**do NOT fall back to `buyingPrice`** (fall back to `0`/empty so the owner types the sell price).
Check how the web new‑order form derives the default sell price and mirror it.

---

## 4. OFFICE REDESIGN — status, APPROVED design, what remains

The owner rejected the first native office as "cheap web design," so the design was reworked as
**interactive HTML demos and APPROVED** before any more SwiftUI. Implement the approved design
faithfully. Design demos (open in Claude, they're live/interactive):
- Boss dashboard demo file: `scratchpad/office-demo.html` (published artifact `office-native-v4-complete`).
- Staff panel demo file: `scratchpad/staff-demo.html` (published artifact `staff-panel-v1`).
  (Scratchpad is session‑local; the HTML files are the source of truth — re‑publish if needed.)

**Approved design language (iOS 26 "Liquid Glass" on the ALMA aura):**
- The **ALMA aura is the brand theme — it must be the background on EVERY screen** (owner rule).
  Cards are translucent Liquid‑Glass (blur+saturate, 0.5px specular hairlines) floating on the aura.
- **SF‑Symbol glyphs, NOT emoji, in chrome** (emoji only inside human message text). One restrained
  coral accent `#E4785E` on primary actions; iOS‑system semantic colors for state.
- Large‑title nav + segmented control, inset‑grouped lists (fills + hairlines), Dynamic‑Island live
  indicator, real spring physics, tabular + Bangla numerals, SF + Kohinoor Bangla (no webfonts).
- Bar to clear on every element: **"Would Apple ship this?"** If not, redesign.

**Boss dashboard sections (KEEP ALL — owner was burned twice by sections silently dropped):**
KPI tiles · **সপ্তাহের সেরা (performer)** · **অনুমোদনের অপেক্ষায় (approval queue w/ approve/redo
buttons)** · **টিম স্ট্যাটাস ও টাস্ক** (each staff row is an accordion; tapping a name reveals THAT
staff's todolist inline — done items checked, active items open; a not‑checked‑in staff shows
"চেক‑ইন করলে টাস্ক দেখাবে") · update‑tracking (with 📞 tel: call + remind) · agent penalty/reward
proposals · activity feed · leaderboard · staff performance table · notifications · history · the
group‑chat entry card with unread count.

**Chat (Messenger/WhatsApp feel):** bubbles (own right/coral, others left w/ avatar, agent tinted),
image bubbles (AsyncImage), agent‑draft approve/dismiss (owner‑only), **a real composer with image
upload + text field + mic/send** (the owner explicitly wants type + image back), plus the intercom.

**Floating Chat Head (owner's signature ask):** a Messenger‑style chat head that floats over the
WHOLE app — drag with inertia, snap to edge, long‑press → radial quick actions (walkie / call /
mute), tap → opens the group chat. App‑wide overlay (window‑level UIKit/SwiftUI over both the
WebView and native screens).

**LIVE INTERCOM — the big missing feature set** (owner: *"walkie talkie system voice + live calling
system"*). It already exists on the web branch **`office-live-intercom`** (Agora‑powered). Study it:
- `src/agent/hooks/useAgoraIntercom.ts` (push‑to‑talk walkie‑talkie channel), `useAgoraCall.ts`
  (1:1 live call), `src/agent/lib/office-intercom.ts`, routes under
  `src/app/api/assistant/office/intercom/` (`route.ts`, `call-token`, `receipt`, `transcribe`),
  and `public/office-intercom-demo.html` (the UX: press‑hold mic → auto‑plays full‑screen on staff
  phones as a walkie‑talkie takeover even if silent → staff "শুনেছি" confirm receipts; one‑tap live
  call full‑screen; urgent full‑volume alert; agent auto‑transcript → task). Port to Swift with the
  **Agora iOS SDK** (new pod + mic permission — a real dependency add; do it carefully).

**What's implemented on `office-native` so far (role‑based owner hub, pre‑approval + partial
redesign):** role probe via `/api/assistant/office/hub`, `PortalOwnerHubView` with all sections,
owner actions wired (`/api/assistant/office/action`), messenger‑ish chat (native image send via
`AlmaAPI.uploadMultipart` → `/api/assistant/office/upload`), and the new native‑polish pass started
(large‑title header, SF‑symbol KPI tiles, team+todolist accordion). **A TEMP sample‑data injection
lives in `PortalOfficeVM.loadHub()`'s catch (`PortalOwnerHub.sampleJSON`) so the dashboard renders
in the sim without the API — REMOVE it before shipping.**

**HARD DEPENDENCY — deploy `/api/assistant/office/hub` to prod.** The native app talks to
production (`alma-erp-six.vercel.app`). The owner‑hub role probe route is only on `office-native`.
Until it's deployed, `loadHub()` fails and the office falls back to the STAFF view — i.e. the owner
still sees the employee screen. The owner's session IS `isSystemOwner` on prod (verified: GET
`/api/assistant/office/history` returns 200). New agent routes may live only under
`/api/assistant/*` (never `/api/agent/*`).

---

## 5. LEARNINGS / GOTCHAS

- **iOS Simulator:** `iPhone 17 Pro Max`, udid `94E0186B-5CDA-4708-9368-53B4FF7274E7`, bundle
  `com.almatraders.erp`. It shares the owner's LIVE prod login (avoid destructive taps). Build:
  `xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug -destination
  'platform=iOS Simulator,name=iPhone 17 Pro Max' -derivedDataPath /tmp/alma-sim-dd build`; then
  `xcrun simctl install/launch`, `xcrun simctl io <udid> screenshot`.
- **UNIVERSAL CONTROL steals sim focus** between screenshot and click (owner has a linked iPad).
  Re‑`open_application "Simulator"` before EVERY click; wheel‑scroll often fails → use
  `left_click_drag` to scroll SwiftUI lists. Ask the owner to unlink the iPad for heavy sim work.
- **Never register two concurrent `xcodebuild` runs on the same `-derivedDataPath`** → "database is
  locked". Kill stray builds (`pkill -9 xcodebuild`) if it happens.
- Money = whole‑taka Ints via `roundMoney` (`src/lib/money.ts`); never raw floats.
- App‑lock passcode for the sim is in Claude memory `reference_ios_sim_access` — NEVER commit it.
- Don't remove existing sections/components when adding new ones (owner hit this twice — be careful).

---

## 6. OWNER RULES (recurring)

- Reply in **Bangla**; code/commits in English.
- **Show live proof** (sim/Chrome screenshot) before saying "done"; build passing ≠ proof.
- For big UI, **design first as a live HTML demo (Claude artifact) and get approval** before SwiftUI.
- Aura brand theme on every page. iOS‑native polish, Apple‑HIG bar.
- Owner authorized merging agent PRs to main + running the TestFlight build himself‑via‑Claude.
- Self‑test hard before asking the owner to test; batch fixes into ONE TestFlight build.

---

## 7. FILES TOUCHED THIS SESSION (for orientation)

- Done (on `native/voice-console`, shipped): `ios/App/App/CatalogImagesSwiftUI.swift`,
  `OrdersSwiftUI.swift`, `OrderCreateSwiftUI.swift`, `MoreMenuSwiftUI.swift`, `KeyboardDismiss.swift`
  (new), `App.xcodeproj/project.pbxproj`, `src/agent/lib/catalog/product-images.ts`.
- Office (on `office-native`): all of the above **plus** `PortalOfficeSwiftUI.swift` (large),
  `AlmaAPI.swift` (multipart), `src/app/api/assistant/office/hub/route.ts` (new).
- Relevant memories: `project_apple_developer_enroll` (build recipe), `project_native_office_hub`
  (office role dependency), `reference_ios_sim_access`, `project_ios_native_frame`, `feedback_merging`.
