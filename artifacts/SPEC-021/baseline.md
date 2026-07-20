# SPEC-021 Baseline — Versioned provider pricing registry
No typed pricing registry existed (legacy cost-events.ts tracks after-the-fact,
not a priced registry). New: nano-USD versioned registry with source+date+verify
flag. USD only — no BDT (exchange rate moves daily, owner decision). Additive,
zero model calls. Legacy cost-events.ts untouched.
