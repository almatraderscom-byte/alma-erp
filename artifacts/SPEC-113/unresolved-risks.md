# SPEC-113 Unresolved Risks
Critical unresolved risks: **0**.

Notes: the ceiling + financial categories + always-approve set are owner-tunable data supplied at construction (zod-validated). The rule reads amountNano from the action descriptor; upstream stages (tool gateway, G13) are responsible for populating that attribute from the validated tool arguments — if it is absent the rule fails closed (require_approval), so a missing amount is safe, not exploitable.
