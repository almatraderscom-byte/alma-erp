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
import { isUnintelligibleTranscript } from '../voice-relay/transcript-guard.mjs'

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
