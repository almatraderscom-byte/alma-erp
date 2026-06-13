/**
 * Staff task proposal — delegates to worker-side evening-proposal.mjs (profiles on VPS).
 * @deprecated Direct import — use evening-proposal.mjs
 */
export { runTaskProposal, runEveningProposal, buildWorkerTaskProposal, loadStaffProfiles } from './evening-proposal.mjs'

/** @deprecated Use runEveningProposal or runTaskProposal */
export async function runMorningProposal(supabase) {
  const { runTaskProposal } = await import('./evening-proposal.mjs')
  return runTaskProposal(supabase, { targetOffsetDays: 0 })
}
