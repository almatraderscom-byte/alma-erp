# Admission Control Plane (G02)

The single door into the AIOS request path. Everything inbound (Telegram,
assistant API, cron) enters through `admit()` in `gateway.ts`.

- `gateway.ts` — `admit(raw, stages)` → typed `ComponentResult<AdmissionReceipt>`.
  Validates the request envelope + identity (G01 `validateRequest`), then runs
  ordered `AdmissionStage`s, short-circuiting on the first typed failure.
- `registry.ts` — `ADMISSION_STAGES`, the ordered pipeline. Later G02 specs
  append their stage here (normalize → fast-path → classifiers → dedup).

Invariants honoured: no LLM in admission (INV-01); identity required, fail-closed
(INV-02/05); no provider/model/tool/db call (those come later via Cost Governor
G04 and Tool Gateway G13). Depends only on `@/agent/contracts`; ERP never imports
this (enforced by the forbidden-import gate).

> Owned-zone note: G02's RUNNER also lists `src/app/api/agent`, but that is the
> frozen Hermes legacy API (CLAUDE.md rule #2 — never touch). Admission is
> therefore exposed through NEW `src/app/api/assistant/*` routes instead; the
> legacy surface stays untouched.
