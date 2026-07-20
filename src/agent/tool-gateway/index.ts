/**
 * G13 — Central Secure Tool Gateway (barrel).
 *
 * The single deterministic door every external tool side-effect passes through.
 * Built on G01 contracts, G04 budgets, G10 selection/results, G11 policy and
 * (from SPEC-126) G12 autonomy. Deterministic, fail-closed, ComponentResult-typed
 * (INV-01/INV-05). Grows across G13 SPEC-121..130.
 */
export * from './contract'
export * from './gateway'
