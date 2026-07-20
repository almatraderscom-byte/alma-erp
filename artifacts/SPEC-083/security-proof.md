# SPEC-083 — Security proof
Phantom tools fail CLOSED (MISSING_TOOL) — a capability can never route to a tool
that does not exist, and coverage proves no tool is silently unreachable or
ambiguously double-routed. `queryToolMap` enforces identity and never throws.
Secret scan: none. PASS.
