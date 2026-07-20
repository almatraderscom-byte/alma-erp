# SPEC-112 Unresolved Risks
Critical unresolved risks: **0**.

Notes: this is the pure decision surface. Durable persistence of requests/decisions and single-use enforcement (a grant consumed exactly once) belong to SPEC-118 (expiry/revocation) + a later durable-queue group; here every check is against the data passed in. Full separation-of-duties (role-based approver eligibility beyond "human, not the requester") is SPEC-117.
