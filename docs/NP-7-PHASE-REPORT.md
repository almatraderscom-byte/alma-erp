# NP-7 — Portal, people, operations, inventory, document completion (evidence)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a`

## What shipped

- **OP-01 Office task proof:** main Office screen — PhotosPicker (≤5 photos, compressed ≤1600px jpeg) with previews/remove → `/api/assistant/office/upload` multipart (retry per image) → `staff-action {action:'proof', taskId, imageUrl, imageUrls, text}`. Reused the pre-existing `submitProof` extension (the alternate staff-office view already had it — the audit's stale-comment caveat cut both ways). The "ছবি জমা দিতে ওয়েবে খুলুন" escape is gone.
- **OP-02 Appeal attachment:** penalty appeal sheet — optional screenshot → ≤1280px jpeg base64 → `attachment_data_url` on the waivers POST (web modal payload verbatim).
- **OP-03 Task Spotlight creation:** full native create sheet — title/description/priority/deadline/banner URL/ack/dismiss + multi-assignee picker (`/api/operational-tasks/assignees`), web POST body verbatim.
- **OP-04 Inventory media:** `image_url` field on native product create — web AddProductModal's photo input IS a URL field (no upload API exists web-side; there are no web collection/bulk UIs beyond supplier import = AD-02, already native).
- **OP-05 Employee media/slip:** admin profile-photo upload (linked-user gated; square 512/96 jpeg data URLs → `POST /api/users/{id}/profile-image`); per-employee salary slip was **already native** (`EmployeeSlipPdf`) — revalidated, not rebuilt.
- **FN-02 Invoice PDF preview:** CDIT hosted `pdf_url` → bytes → **PDFKit** preview sheet (`AlmaPDFPreviewSheet`, zoom + share). ALMA `/invoice` share pages remain approved public web (EX-02).
- **FN-03 Salary slips:** My Desk wallet — "এ মাসের/গত মাসের স্লিপ" buttons; breakdown computed with the web `buildSalarySlipBreakdown` rules verbatim → branded A4 PDF → share sheet.
- **OP-07 Canonical check-in:** staff-office check-in banner now routes through `.almaOpenPath("/portal")` → the native front-camera+GPS flow (stale forced-web link removed; that file now has ZERO openWeb sites).
- **OP-08 CDIT contextual:** client detail → "নতুন প্রজেক্ট" prefilled native sheet (web + New Project payload verbatim).

## Verification

- `xcodebuild … iPhone 17 Pro Max build` → **BUILD SUCCEEDED** (one duplicate-method redeclaration caught by the build → deduped to the existing implementation, rebuilt green)
- Feature checker → OK: open actions 13 → **3** (only NP-8 items left); openWeb snapshot: Employees 3→2, PortalOffice 4→3, TaskSpotlight 3→2, **PortalStaffOffice 1→0** — four more internal escapes gone.
- Route checker → OK (70/66).
- Camera/PhotosPicker denial/offline paths: pickers degrade to no-op with error notices; real-camera capture checks are NP-9 owner-hardware items.
