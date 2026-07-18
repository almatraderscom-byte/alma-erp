# Office Calling Phase Evidence

This directory contains the hard-verification record for each implementation phase in
`docs/office-calling-whatsapp-audit-roadmap.md`.

## Fixed goal

This is one continuing, non-stop implementation goal. Phases 0–7 run sequentially
with every available agent-side hard gate; the agent continues automatically after
each PASS. Repeated physical setup is deferred to the single comprehensive Phase 8
iPhone/Android/web matrix, which remains mandatory before release.

## Vercel verification policy

The `agent/office-calling-whatsapp` branch originally set Vercel's `ignoreCommand` to
`exit 0` while the audit/roadmap and local Phase 0 work were being prepared, as
requested by the project owner.

On 2026-07-17 the owner explicitly authorized Vercel use for verification. The branch
therefore restores the repository-standard `bash scripts/vercel-skip-ios-only.sh`
policy. Preview deployments may run for web-relevant changes; production deployment
is not implied by this authorization.

## Gate rule

Each phase must have an evidence file containing the commands, test artifacts,
device/build identifiers, failures found, and a final `PASS` or `FAIL`. Work on the
next phase may start only after the current phase has a hard `PASS`.

Per the owner's 2026-07-17 batching decision, Phases 0–7 may record an engineering
`PASS` with hardware-only rows explicitly marked `DEVICE DEFERRED`; every available
non-device gate must still pass. Phase 8 cannot pass, ship, or remove the legacy path
until the complete real-device matrix and soak are executed on signed builds.
