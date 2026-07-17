# Build 77 — owner's 4 marked fixes (2026-07-17)

1. **5th tab = profile name** (`issue1+2-…`): the More tab now shows the logged-in
   user's own name ("Maruf Chowdhury"), fetched FRESH from /api/users/me on every
   launch — a name change is reflected, never a stale cached label.
2. **Meta Ads (MCP) card on Growth** (`issue1+2-…`): surfaces the merged MA1–MA4
   backend — যুক্ত আছে ✓, Tier: read, 82 tools live. Connect = OAuth (same system
   handoff GSC uses).
3. **Dashboard "order monojog" banner → native** (`issue3-…`): the attention banner
   now posts .almaOpenPath "/orders" (native Orders tab) instead of openWeb.
4. **Live Activity approve/reject buttons** (`issue4-…`): restored অনুমোদন/বাতিল on
   BOTH the lock card (143pt ≤160) and the Dynamic Island expanded (83pt ≤92) —
   the 160pt fix had dropped them from the lock card.
