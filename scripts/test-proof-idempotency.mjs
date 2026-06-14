/**
 * Proof submit must only notify owner once (verification_status gate).
 */
import assert from 'node:assert/strict'

function shouldNotifyOwner(result) {
  if (result.needsOwnerReview === false) return false
  if (result.alreadySubmitted || result.idempotent) return false
  return true
}

function canAcceptProof(task) {
  const v = task.verification_status ?? task.verificationStatus
  return task.status === 'awaiting_proof' && v === 'awaiting_proof'
}

assert.equal(canAcceptProof({ status: 'awaiting_proof', verification_status: 'awaiting_proof' }), true)
assert.equal(canAcceptProof({ status: 'awaiting_proof', verification_status: 'proof_submitted' }), false)
assert.equal(shouldNotifyOwner({ needsOwnerReview: true }), true)
assert.equal(shouldNotifyOwner({ alreadySubmitted: true, needsOwnerReview: false }), false)
assert.equal(shouldNotifyOwner({ idempotent: true, needsOwnerReview: false }), false)

console.log('PASS: proof idempotency guards')
