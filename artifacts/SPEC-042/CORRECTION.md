# SPEC-042 Correction (integrity note)
First attempt asserted the constitution does NOT match /Sir/, but the text legitimately contains `never "Sir"` (the Boss-only rule). The hardened helper flagged `1 failed`; the one-shot finalize block committed before the fix. Corrected the assertion to verify the Boss-only rule is present; re-verified green; amended.
