# SPEC-092 — Security proof
The bound is unconditional (clamped to [1, MAX_SHORTLIST]) so a broad or hostile
intent cannot expand the model's tool surface. Safest-first ranking biases the
default toward read tools. Inherits SPEC-091 permission scoping. `selectToolShortlist`
enforces identity, DENIES on empty, never throws. Secret scan: none. PASS.
