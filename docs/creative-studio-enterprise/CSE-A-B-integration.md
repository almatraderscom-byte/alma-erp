# Creative Studio Enterprise — CSE-A + CSE8 integration

Status: integration contract

Baseline: `b399ba9b47433a5d0dcfd0d5e862b21a600456d1`

Integration branch: `codex/cs-ab-integration`

## Purpose

This record composes the independently implemented Advanced model-fidelity
workstream (CSE-A) with the provider-aware resolution and artifact-integrity
workstream (CSE8). It does not replace either source record. It resolves the
places where a reference/model decision and a resolution/artifact decision
must be one atomic contract.

## Integrated decisions

1. The exact generic image model is allowlisted and snapshotted when the action
   is queued. Its actual family—not a generic “Gemini” label—selects the
   Gemini, GPT Image, or Seedream resolution contract at both UI and worker.
   A later settings change cannot mutate an in-flight action.
2. xAI keeps its ordered product/person/source reference bindings, but only
   native `1k`/`2k` and native aspects are valid. CSE8's fail-closed rule
   supersedes CSE-A's earlier illustrative `4k → 2k` mapping: `4k` and `4:5`
   are rejected before reference preparation, queue spend, or provider calls.
3. Direct FASHN Product→Model continues to map the selected person to
   `face_reference`; its requested `1k`/`2k`/`4k` tier and supported explicit
   aspect are carried alongside the immutable `product-to-model` snapshot.
4. Fixed Fal VTON and source-sized FLUX Fill keep CSE-A reference roles but do
   not inherit named 2K/4K controls. Their adapters validate model, role, path,
   and order before loading references or submitting paid work.
5. Generic rescue/family stages carry the same immutable model, ordered source
   contract, requested tier/aspect, and control mapping through every queued
   follow-on action.
6. Provider bytes are decoded and attributed to the actual provider/model.
   Stored originals retain actual dimensions, MIME/format, byte size, checksum,
   requested tier/aspect, and verification status. Thumbnails and branded
   outputs remain separately traceable derivatives.

## Acceptance coverage

The zero-spend integration fixtures cover:

- xAI multi-reference order plus truthful rejection of unsupported 4K/4:5;
- direct FASHN `face_reference` plus its native tier/aspect capability;
- generic model snapshot to resolution-engine coherence;
- fixed Fal reference validation with no named resolution tier;
- fail-closed model/reference checks before transport or network calls;
- decoded original dimensions, provider/model attribution, checksum, and
  publishability metadata;
- rescue/family follow-on actions retaining model, reference, control, tier,
  and aspect lineage.

No paid provider generation or production deployment is authorized by this
integration record. A future Studio-shell workstream may replace components,
but must preserve these server/worker contracts and their truthful owner-facing
states.
