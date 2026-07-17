# Office Calling Phase Evidence

This directory contains the hard-verification record for each implementation phase in
`docs/office-calling-whatsapp-audit-roadmap.md`.

## Active branch guard

The `agent/office-calling-whatsapp` branch intentionally sets Vercel's
`ignoreCommand` to `exit 0`. This prevents every preview deployment while the phased
calling rebuild is in progress, as requested by the project owner.

**Merge blocker:** restore `vercel.json` to
`bash scripts/vercel-skip-ios-only.sh` before this branch is merged. A phase can be
verified locally and on physical devices, but it must not be marked production-ready
while this guard is active.

## Gate rule

Each phase must have an evidence file containing the commands, test artifacts,
device/build identifiers, failures found, and a final `PASS` or `FAIL`. Work on the
next phase may start only after the current phase has a hard `PASS`.
