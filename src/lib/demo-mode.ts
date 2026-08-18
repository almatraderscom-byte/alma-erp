/**
 * `DEMO_MODE=true` marks a deployment as the throwaway demo instance — a separate
 * database, seeded with fake data (`scripts/demo-seed.mjs`), that can be handed to a
 * customer or an app reviewer.
 *
 * The demo's data is fake; its *outbound channels would not be*. A demo tester who
 * creates an order would otherwise fire a real SMS, a real email and a real Telegram
 * message from the company's own accounts — to made-up numbers, at the owner's cost.
 * Every outbound sender therefore checks this flag first and reports a clean success
 * without dispatching anything.
 *
 * Production never sets the flag, so every call below is a no-op there.
 */
export function isDemoDeployment(): boolean {
  return process.env.DEMO_MODE === 'true'
}

/** Marker used in place of a provider id so demo rows are obvious in any log. */
export const DEMO_SUPPRESSED_ID = 'demo-suppressed'
