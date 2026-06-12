/**
 * Evening Proposal Job — 20:00 Asia/Dhaka
 * Proposes TOMORROW's staff tasks; owner approves tonight.
 */
import { runTaskProposal } from './morning-proposal.mjs'

export async function runEveningProposal(supabase) {
  return runTaskProposal(supabase, { targetOffsetDays: 1 })
}
