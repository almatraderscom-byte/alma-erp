# Reopen-sync + stranded-turn watchdog — proof ledger

Owner incident 2026-08-26: iOS sat on "কাজ চলছে — সংযোগ ফিরছে…" indefinitely.
Root cause was SERVER-side: the executing process died without finalizing and
chat-lane turns had no reaper — 54 forever-'running' corpses found (back to
June), including the owner's screenshot turn (687bc175, started 18:46:30Z,
died mid-thinking at 18:47:35Z during an engine deploy restart). All 54
manually finalized the same night; /api/cron/turn-watchdog (5-min sweep,
30-min activity staleness) closes the class permanently.

iOS web-parity reopen (this ledger's screenshots, ALMA Preview E2E simulator,
ALMA_REOPEN_SYNC_FIXTURE=1 harness):
1. `1-reopen-sync-begins.png` — coming back to a RUNNING conversation starts
   the ONE session loader (ALMA robot) over the live chat.
2. `2-loader-over-running-chat.png` — the loader holds while recovery re-syncs
   with the server (content behind, thinking row live).
3. `3-dismissed-settled.png` — the first fresh truth dismisses it smoothly;
   settled state, no duplicate loader, no stale status line.
The loader's own 12s hard ceiling guarantees the sync overlay can never
become a stuck state itself.
