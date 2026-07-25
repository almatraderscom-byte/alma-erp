# Creative Studio Enterprise — CSE8 Resolution Integrity

Status: implementation workstream
Baseline: `agent-phase-cse7` at `b399ba9b47433a5d0dcfd0d5e862b21a600456d1`
Branch: `codex/cs-resolution-integrity`
Pre-work tag: `pre-codex-cs-resolution-integrity`

## Purpose

CSE8 makes image resolution a verified artifact property instead of a request
label. A Creative Studio control may advertise `2K` or `4K` only when the
selected provider/model accepts that tier and the decoded stored original meets
the corresponding contract. A provider response, database row, signed URL, or
download filename must never acquire a higher-resolution label merely because
the user requested one.

This work preserves CSE1–CSE7 policy, approval, retention, brand/role isolation,
budget, idempotency, and audit behavior. It does not introduce paid validation
calls, an unapproved third-party upscaler, or a production deployment.

## Truthful tier semantics

The tier is a provider-native quality request plus a decoded-pixel gate. It is
not a CSS size, thumbnail size, filename suffix, metadata-only promise, or an
instruction to enlarge bytes after generation.

| Tier | Truth gate | Canonical square | Canonical 4:5 | Canonical 9:16 | Canonical 16:9 |
|---|---|---:|---:|---:|---:|
| 1K | long edge at least 1,024 px; provider's documented approximately-1 MP contract | 1024×1024 | 928×1152 | 768×1376 | 1376×768 |
| 2K | long edge at least 2,048 px; provider's documented approximately-4 MP contract | 2048×2048 | 1856×2304 | 1536×2752 | 2752×1536 |
| 4K | long edge at least 3,840 px; provider's documented high-resolution contract, at least 8,294,400 decoded pixels | 4096×4096 | 3712×4608 | 3072×5504 | 5504×3072 |

The dimensions above are the Creative Studio canonical dimensions and the
exact Gemini native dimensions. A provider whose documented native dimensions
differ may still use the same tier only if it passes the truth gate and the UI
and artifact metadata show the exact decoded dimensions. For example,
OpenAI's exact 16:9 4K contract is 3840×2160, not 5504×3072. Source-preserving
edit modes display `Source dimensions`, not a named tier. Fixed-output models
display their documented exact native dimensions.

Aspect tolerance is limited to one provider alignment unit per edge (16 px for
arbitrary-size GPT Image requests). EXIF orientation is applied before width and
height are recorded. The database truth comes from decoding the received bytes,
never from provider JSON alone.

## Provider/model capability matrix

| Provider/model or route | Native size options | Maximum/documented pixel contract | Aspect constraints | Response and metadata | CSE8 decision |
|---|---|---|---|---|---|
| xAI `grok-imagine-image` / quality | `1k`, `2k` | nominal 1024² / 2048² tier; no 4K | 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2 and documented phone ratios; no 4:5 | temporary URL or base64; bytes may be JPEG and must be sniffed | expose 1K/2K only; reject 4K and 4:5; validate decoded long edge/tier; preserve original bytes |
| Google `gemini-3.1-flash-image` | 1K/2K/4K | exact table above | 1:1, 4:5, 9:16, 16:9 used by Studio | inline image bytes; MIME provided | expose all tiers; send uppercase `imageSize`; require exact decoded dimensions |
| Google `gemini-3-pro-image` | 1K/2K/4K | exact table above | same Studio set | inline image bytes; MIME provided | expose all tiers; require exact decoded dimensions |
| Google `gemini-2.5-flash-image` if configured | fixed approximately 1K | fixed model output | model-supported aspect list | inline image bytes | expose 1K only; never inherit 2K/4K defaults |
| OpenAI `gpt-image-2` | arbitrary aligned dimensions | each edge ≤3840, both divisible by 16, ≤8,294,400 pixels | ratio ≤3:1; Studio exact requests below | base64; PNG default, JPEG/WebP optional | 1K/2K for all Studio ratios; 4K only 3840×2160 or 2160×3840; 4K square/4:5 unsupported; send exact requested dimensions and validate them |
| ByteDance Seedream 5 Pro via Fal | custom size, `auto_1K`, `auto_2K` | 1,048,576–4,194,304 pixels | Studio ratios via exact custom dimensions | URL plus width/height/format/size metadata | expose 1K/2K; reject 4K; selected tier, not quality, controls dimensions; decode despite response metadata |
| FASHN `tryon-max` | 1k/2k/4k | approximately 1/4/16 MP | output follows try-on inputs; no explicit aspect parameter | URL or base64, PNG/JPEG | expose all tiers; label aspect as source-derived; decode and validate tier |
| FASHN `product-to-model` | 1k/2k/4k | approximately 1/4/16 MP | explicit 1:1, 3:4, 4:3, 9:16, 16:9, 2:3, 3:2, 4:5, 5:4 | URL or base64, PNG/JPEG | expose all tiers and pass supported aspect |
| FASHN `face-to-model` | 1k/2k/4k | approximately 1/4/16 MP | vertical 1:1, 4:5, 3:4, 2:3, 9:16 | URL or base64, PNG/JPEG | expose all tiers and pass supported aspect |
| FASHN `model-swap` / `edit` | 1k/2k/4k | approximately 1/4/16 MP | source-derived | URL or base64, PNG/JPEG | expose all tiers; display source-derived aspect; validate tier |
| Fal FASHN v1.6 | fixed 864×1296 processing | 1,119,744 pixels | fixed portrait | URL/file metadata | no 1K/2K/4K control; display `Native 864×1296` |
| Fal CatVTON | provider image-size/custom surface exists, current controlled adapter has no tier contract | current route is not resolution-addressable | source/model dependent | URL/file metadata | no named tier until adapter and acceptance fixtures define a contract |
| Fal FLUX Fill protected composite | source dimensions | exact source width×height | input image and mask must match | generated URL, then controlled PNG composite | display `Source dimensions`; selected tier is inapplicable |
| Campaign/brand finishing | fixed social derivative | 1080×1080 or 1080×1350 JPEG | layout-specific | local Sharp bytes | store as an explicit `branded` derivative; never replace or default-download the 2K/4K original |
| Grid thumbnail | fixed derivative | 480 px maximum edge WebP | source-derived | local Sharp bytes | thumbnail only; never use for lightbox/download resolution claims |

### Exact arbitrary-size requests

| Provider | Tier | 1:1 | 4:5 | 9:16 | 16:9 |
|---|---|---:|---:|---:|---:|
| OpenAI GPT Image 2 | 1K | 1024×1024 | 928×1152 | 768×1376 | 1376×768 |
| OpenAI GPT Image 2 | 2K | 2048×2048 | 1856×2304 | 1536×2752 | 2752×1536 |
| OpenAI GPT Image 2 | 4K | unsupported | unsupported | 2160×3840 | 3840×2160 |
| Seedream 5 Pro | 1K | 1024×1024 | 928×1152 | 768×1376 | 1376×768 |
| Seedream 5 Pro | 2K | 2048×2048 | 1824×2272 | 1536×2720 | 2720×1536 |
| Seedream 5 Pro | 4K | unsupported | unsupported | unsupported | unsupported |

## End-to-end trace and root causes

1. `StudioWorkspaceView` currently renders a global 1K/2K/4K list, regardless
   of effective provider, model, or mode.
2. `create-run` serializes the selected label, but xAI clamps every non-1K
   request to 2K and maps 4:5 to 3:4. Fal FASHN v1.6 and CatVTON ignore the
   selection. Gemini fallback queues omit size/aspect. Several rescue/family
   stages hard-code 2K.
3. The generic worker sends the Gemini size correctly, but GPT Image 2 always
   receives a roughly-1K fixed size and Seedream derives its size from quality
   instead of the selected tier.
4. Provider URL/base64 bytes are uploaded without a decoded dimension,
   format, byte-size, or checksum gate. xAI base64 is currently labelled PNG
   even when the response bytes are JPEG.
5. Job success JSON and CSE3 version metadata discard requested-versus-actual
   resolution and variant lineage.
6. Supabase object signing does not transform the full original. Creative
   Studio uses plain `<img>` elements, not `next/image`; Next.js optimization
   is not the cause.
7. The grid intentionally uses a 480 px WebP thumbnail. The lightbox uses a
   full signed object, but once a brand finish exists it defaults to a fixed
   1080 px JPEG derivative. Download then fetches that displayed derivative
   and hard-codes a `.jpg` name. This is a separate, real resolution loss.

The defect therefore has multiple causes: false capability advertising,
request mapping/omission, fixed-size worker payloads, absent byte validation
and persistence, and default selection of a smaller social derivative. Storage
CDN transformation and Next/Image are excluded.

## Architecture and data contract

Every received image is decoded once with Sharp before it is accepted. The
artifact descriptor contains:

```json
{
  "kind": "original",
  "storagePath": "creative-studio/…",
  "width": 2048,
  "height": 2048,
  "pixelCount": 4194304,
  "format": "png",
  "mimeType": "image/png",
  "byteSize": 1234567,
  "sha256": "…",
  "requestedTier": "2k",
  "requestedAspectRatio": "1:1",
  "actualTier": "2k",
  "validation": "verified",
  "provider": "xai",
  "model": "grok-imagine-image"
}
```

The callback keeps a `variants` collection. `original`, `thumbnail`, and
`branded` paths are independent descriptors; a transformation records its
source kind and transform version. The CSE3 asset-version JSON metadata stores
the same immutable descriptors, so retention and archive path collection
continue to work while acquiring audit evidence. No schema migration is
required for this phase because `CreativeAssetVersion.metadata` and job
`result` are already JSON; this avoids widening CSE3 relational behavior.

Provider payload acceptance and decoded-byte acceptance are separate gates:

- unsupported selections fail before a job or billable provider request exists;
- a provider output that violates the selected contract is preserved for
  audit but the job is marked with a resolution-integrity failure and is not
  publishable;
- MIME type and file extension come from decoded bytes, not a URL suffix;
- originals are never recompressed;
- thumbnails and brand frames are traceable derivatives;
- download defaults to the verified original and uses its actual format;
- cost checks and idempotency keys stay before provider execution;
- artifact descriptors contain no signed URLs and preserve current
  brand/role-scoped path controls.

## Upscale decision

No approved deterministic high-quality image upscaler exists in the repository.
Sharp resize is appropriate for thumbnails/layout derivatives but is not a
quality-restoring 2K/4K generation stage. Therefore CSE8 performs no synthetic
upscale. Unsupported provider/model/aspect/tier combinations are disabled in
the UI and rejected server-side with an explicit message. Adding a learned
upscaler later requires a separate owner-approved provider, maximum cost,
security/data-residency review, idempotency contract, quality acceptance
fixtures, and distinct `upscaled` variant lineage.

## Verification gates

- provider contract tests cover every provider/model/mode and exact payload;
- PNG, JPEG, and WebP fixture bytes prove decoded dimensions, MIME, byte size,
  hash, mismatch rejection, and original-byte preservation;
- callback/version/gallery tests prove descriptors survive persistence and
  signed full-resolution URL selection;
- UI tests prove only supported tiers/aspects render, fixed/source modes state
  that fact, and lightbox/download default to the verified original;
- finishing tests prove the 1080 derivative is separately labelled;
- retention/archive tests prove all variant paths remain discoverable;
- targeted suites, full app and worker suites, lint, typecheck, Prisma checks,
  production build, exact diff, clean worktree, preview identity, and safe
  authenticated runtime checks must pass before handoff.

Any live provider generation remains blocked without explicit owner approval
and an exact maximum spend.
