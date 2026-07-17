# Office Calling Phase Evidence

This directory contains the hard-verification record for each implementation phase in
`docs/office-calling-whatsapp-audit-roadmap.md`.

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
