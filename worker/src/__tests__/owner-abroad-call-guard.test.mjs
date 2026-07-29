/**
 * Owner-abroad call switch — destination guard.
 * The abroad flag must block OWNER-destined calls only; staff/contact calls
 * (explicit non-owner toNumber) must never match.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { isOwnerDestinedCall } from '../notify/twilio-call.mjs'

beforeEach(() => {
  process.env.TWILIO_TO_NUMBER = '+8801712345678'
  process.env.NGS_TO = '01712345678'
  process.env.OWNER_PHONE_NUMBERS = '+8801712345678,+971501234567'
})

test('no toNumber (default destination) is the owner', () => {
  assert.equal(isOwnerDestinedCall(undefined), true)
  assert.equal(isOwnerDestinedCall(null), true)
  assert.equal(isOwnerDestinedCall(''), true)
})

test('owner number matches in every dial form', () => {
  assert.equal(isOwnerDestinedCall('+8801712345678'), true)
  assert.equal(isOwnerDestinedCall('8801712345678'), true)
  assert.equal(isOwnerDestinedCall('01712345678'), true)
})

test('secondary owner number (OWNER_PHONE_NUMBERS) matches', () => {
  assert.equal(isOwnerDestinedCall('+971501234567'), true)
})

test('staff/contact numbers do not match', () => {
  assert.equal(isOwnerDestinedCall('+8801898765432'), false)
  assert.equal(isOwnerDestinedCall('01898765432'), false)
})
