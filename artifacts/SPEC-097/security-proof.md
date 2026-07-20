# SPEC-097 — Security proof
Every truncation is explicitly marked (_omitted/_len/_omittedKeys/depthClipped) so
the summary is honest, never silently lossy. No LLM means no prompt-injection
surface in summarization. `summarizeResult` enforces identity and never throws.
Secret scan: none. PASS.
