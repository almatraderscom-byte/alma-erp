# SPEC-124 — Security proof
Authorization is delegated to the G11 Policy Engine and is fail-closed (INV-05):
missing principal/resource, no applicable permit, or an explicit deny all stop the
pipeline before cost/execution. Obligations (redact/mask) are carried forward so
SPEC-126 can enforce them. No side effect precedes authorization. Never throws.
Secret scan: none. PASS.
