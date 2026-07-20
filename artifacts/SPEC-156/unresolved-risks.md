# SPEC-156 Unresolved Risks
1. The approval authority (who issues valid tokens) and the durable per-day
   counter are wired by the autonomy/approval governance group (G12) + G17 — the
   default here is fail-closed (reject all), so no accidental frontier spend.
2. Daily cap is attempt-based (consumed at admission); a failed provider call
   still consumes an attempt (deliberate — throttles retries of costly calls).
No unresolved **critical** risks. Count: 0.
