# SPEC-013 Baseline — Deterministic fast-path command router
No fast-path existed; every message would hit classification/model. This spec
routes known slash-commands to handlers with ZERO model calls (INV-01). Depends
on normalize (SPEC-012). Additive, owned zone. Zero cost.
