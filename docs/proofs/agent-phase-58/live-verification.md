# Roadmap 3 — LIVE Chrome verification (owner's browser, Vercel preview)

Date: 2026-07-17 ~13:05 (Asia/Dhaka)
Preview: alma-erp-git-claude-agent-roadmap-phas-3f4007-maruf-s-projects2.vercel.app (deployment dpl_AvmUGPggPa8RUrDGG5HH7rUBG4UK, commit c181d176, state READY; build ~4 min incl. the two additive migrations)
Method: Claude drove the owner's Chrome (Chrome MCP); owner performed login only. Screenshots delivered in-chat.

## Verified live, in order

1. **Staff-monitor renders the new surfaces** — Control Center + "স্বয়ংক্রিয়তার সিঁড়ি" with all 15 task-family cards (Bangla will/won't per rung, tier + ceiling shown; R3 cards show ceiling খসড়া, R4 cards show ceiling ছায়া). Zero console errors.
2. **Ladder promote (P57)** — memory-notes "এক ধাপ বাড়াও" → toast "এক ধাপ বাড়ানো হলো", badge বন্ধ→ছায়া, card text switched to the shadow will/won't copy. Persisted via POST /api/assistant/controls against the prod KV.
3. **Evidence gate blocks (P57)** — immediate second promote → red toast "আটকে গেছে: নমুনা কম: 0/25 — আরো shadow/canary চালাতে হবে". No stage change.
4. **Instant pause (P57 exit gate)** — "বন্ধ করো" → toast "বন্ধ করা হলো — পরের কাজ থেকেই কার্যকর", badge back to বন্ধ, pause button disabled.
5. **SLO panel (P58)** — zero-invariant tiles live: ডুপ্লিকেট effect 0, অনুমোদনহীন বড় কাজ 0, অজানা অবস্থার effect 0, গার্ড কাভারেজ 100%; honest empty-state ("এখনো কোনো effect রেকর্ড হয়নি"); Outbox due 0 · চলমান 0 — i.e. the Phase 53/56 tables exist in prod (migrations applied on this deploy) and the panel reads them.
6. **Agent chat smoke through the guard (P52)** — fresh owner-surface turn sent from the preview tab: "test: ajker date ta ki?" → head called get_current_datetime through the guarded executor → correct reply "আজ ১৭ জুলাই ২০২৬, শুক্রবার"। Owner's own concurrent turns (sales report, top product) also completed with tool calls — no regression in normal flows.

## Result

All browser-observable exit gates PASS on the live preview. Remaining behaviour (effect engine, reconciler, point-of-risk enforcement) stays flag-OFF by design and is covered by the CI suites + chaos tests recorded per phase.
