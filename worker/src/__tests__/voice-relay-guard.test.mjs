/**
 * Unit tests for the relay's heard-it-wrong guard (worker/src/voice-relay/server.mjs).
 *
 * The strings below are VERBATIM from production transcripts (agent_voice_calls,
 * 2026-06-27): the caller spoke Bangla and the ASR returned Hindi Devanagari. The
 * model answered that garbage as if it were real — the owner's "amar kotha na bujhei
 * nijer moto kotha bola". These must never reach the model again.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isUnintelligibleTranscript,
  endSignalFromCaller,
  isHangupConfirmation,
} from '../voice-relay/transcript-guard.mjs'

test('real mis-heard Hindi transcripts from prod are rejected', () => {
  for (const t of [
    'आपकी जानकारी के लिए बहुत बहुत।',
    'हाँ, नहीं, हम दोनों जगह पर वहाँ वहाँ देंगे। दोनों जगह पर वहाँ वहाँ दे',
    'मैं ठीक हूँ',
  ]) {
    assert.equal(isUnintelligibleTranscript(t), true, t)
  }
})

test('genuine Bangla speech passes through', () => {
  for (const t of [
    'হ্যালো',
    'জি বলুন, কে বলছেন?',
    'আমি ভালো আছি, আপনি কেমন আছেন?',
    'কালকের ডেলিভারিটা কনফার্ম করে দিয়েন',
  ]) {
    assert.equal(isUnintelligibleTranscript(t), false, t)
  }
})

test('Banglish / English speech passes (people code-switch on calls)', () => {
  assert.equal(isUnintelligibleTranscript('hello ke bolchen'), false)
  assert.equal(isUnintelligibleTranscript('ok fine'), false)
})

test('noise, punctuation and empty are rejected', () => {
  for (const t of ['', '   ', '।', '...', '?', 'a']) {
    assert.equal(isUnintelligibleTranscript(t), true, JSON.stringify(t))
  }
})

test('mixed Bangla+Devanagari is kept — Bangla content is present', () => {
  assert.equal(isUnintelligibleTranscript('হ্যাঁ ठीक আছে'), false)
})

// ── endSignalFromCaller: only a real human goodbye may end the call ──────────
test('genuine goodbye phrases end the call', () => {
  for (const t of [
    'আচ্ছা তাহলে রাখছি',
    'ঠিক আছে রাখি, ভালো থাকবেন',
    'আর কিছু লাগবে না, ধন্যবাদ',
    'আর কিছু বলার নেই',
    'আল্লাহ হাফেজ',
    'খোদা হাফেজ',
    'বিদায় বস',
    // the EXACT phrases the owner used that the first regex missed (2026-07-18)
    'তুমি কল কেটে দাও',
    'এখন রাখো',
    'কল কেটে দাও',
    'রেখে দাও এখন',
    'ok rakhi',
    'thik ache bye',
    'accha bye',
    'ok bye',
    'ekhon rakho',
    'kete dao',
  ]) {
    assert.equal(endSignalFromCaller(t), true, t)
  }
})

test('a "shall I hang up?" reply: only a short yes confirms', () => {
  for (const t of ['হ্যাঁ', 'জি', 'হুম', 'আচ্ছা', 'রাখো', 'হ্যাঁ রাখো', 'ok', 'জি রাখো', 'বিদায়']) {
    assert.equal(isHangupConfirmation(t), true, t)
  }
  for (const t of [
    'না আজকের সেলটা আগে বলো',      // wants to continue
    'আচ্ছা তারপর কী হলো?',        // a new question, not a yes
    'একটু দাঁড়াও আরেকটা কথা আছে', // long → continuation
    'না না বন্ধ কোরো না',
  ]) {
    assert.equal(isHangupConfirmation(t), false, t)
  }
})

test('mid-conversation speech NEVER ends the call (the auto-cut bug)', () => {
  for (const t of [
    'আজকে সেল কত হয়েছে বলো তো',
    'আচ্ছা, তারপর কী হলো?',      // "আচ্ছা" alone is not a goodbye
    'ধন্যবাদ, এখন বলো আজকের অর্ডার কেমন', // "ধন্যবাদ" alone is not a goodbye
    'এটা একটু রাখো তো',           // "রাখো" (keep this) is not "রাখছি" (hanging up)
    'আমি ভালো আছি',
    'হ্যাঁ বলুন',
    'আর কিছু জানি না',            // "আর কিছু...না" WITHOUT লাগবে/বলার is not an ending
    'okay tell me more',
  ]) {
    assert.equal(endSignalFromCaller(t), false, t)
  }
})
