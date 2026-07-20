# SPEC-018 Correction (integrity note)

First attempt classified "what is the order status?" as MED because the noun
"order" matched a side-effect verb pattern — a false positive; a read-only
question is LOW. The hardened capture helper flagged the failing test loudly
(`1 failed | 51 passed`), but it was committed before the fix landed.

**Fix:** `classifyRisk` is now question-aware — an interrogative does not escalate
on side-effect nouns, while money/destructive terms still force HIGH even when
phrased as a question (fail-closed preserved). Re-verified 52/52 green; this
commit was amended to include the fix.
