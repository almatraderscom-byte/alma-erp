/**
 * Owner, live 2026-07-27: the head said *"ভুল ছিল, audit_product_seo সঠিক
 * প্যারামিটার ছাড়া চালাইনি — এখন সঠিকভাবে চালাচ্ছি"* and the turn ended there.
 *
 * Two rules collided. The failure guard refuses to push when the head names the
 * same tool that just failed — right for hammering a broken call. And since the
 * same day the verifier REQUIRES an honest admission when an opening-line promise
 * went unmet — so the reply contains "পারিনি", which made it read as a blocked
 * sign-off. Between them, the one thing that would have finished the job was the
 * one thing suppressed.
 */
import { describe, it, expect } from 'vitest'
import { shouldNudgeAdapterIntent, isArgumentFailure } from '@/agent/lib/turn-loop-policy'

const LIVE_TEXT = `Boss, আপনার অনুমোদন অনুসারে title meta ঠিক করছি — seo-fixing-own-site skill ধরে সঠিক audit চালাতে যাচ্ছি।

ভুল ছিল, audit_product_seo সঠিক প্যারামিটার ছাড়া চালাইনি — এখন সঠিকভাবে চালাচ্ছি। (কার্ড তৈরি করতে পারিনি, সেটা সংশোধন করলাম।)`

const nudge = (text: string, rec: { status: 'success' | 'error'; toolName?: string; errorCode?: string }) =>
  shouldNudgeAdapterIntent({ text, toolRecords: [rec], hasAskCard: false, ownerRequestedAction: true })

describe('a corrected retry is not hammering', () => {
  it('pushes on the exact reply the owner watched stall', () => {
    expect(nudge(LIVE_TEXT, { status: 'error', toolName: 'audit_product_seo', errorCode: 'invalid_args' })).toBe(true)
  })

  it('still refuses to hammer a genuinely broken call', () => {
    expect(nudge(
      'audit_product_seo চালাতে পারিনি — সার্ভার সাড়া দেয়নি। আবার audit_product_seo চালাচ্ছি।',
      { status: 'error', toolName: 'audit_product_seo', errorCode: 'provider_5xx' },
    )).toBe(false)
  })

  it('still pushes when a DIFFERENT tool is named — unchanged behaviour', () => {
    expect(nudge(
      'audit_product_seo ব্যর্থ। এখন get_website_catalog চালাচ্ছি।',
      { status: 'error', toolName: 'audit_product_seo', errorCode: 'provider_5xx' },
    )).toBe(true)
  })

  it('classifies argument failures and nothing else', () => {
    expect(isArgumentFailure({ status: 'error', errorCode: 'invalid_args' })).toBe(true)
    expect(isArgumentFailure({ status: 'error', errorCode: 'malformed_args' })).toBe(true)
    expect(isArgumentFailure({ status: 'error', errorCode: 'provider_5xx' })).toBe(false)
    expect(isArgumentFailure({ status: 'error' })).toBe(false)
    expect(isArgumentFailure({ status: 'success', errorCode: 'invalid_args' })).toBe(false)
    expect(isArgumentFailure(undefined)).toBe(false)
  })
})

describe('an honest admission is not a sign-off', () => {
  it('a "could not" plus work in flight still gets pushed', () => {
    expect(nudge(
      'কার্ড তৈরি করতে পারিনি, সেটা সংশোধন করলাম। এখন get_website_catalog দেখছি।',
      { status: 'error', toolName: 'draft_seo_fixes', errorCode: 'provider_5xx' },
    )).toBe(true)
  })

  it('a "could not" with the work PARKED for later is left alone', () => {
    expect(nudge(
      'কার্ড তৈরি করতে পারিনি। পরের ধাপে আবার দেখব।',
      { status: 'error', toolName: 'draft_seo_fixes', errorCode: 'provider_5xx' },
    )).toBe(false)
  })

  it('a question to Boss still ends the turn', () => {
    expect(nudge(
      'audit_product_seo চালাতে পারিনি। আপনি কি চান আমি আবার চেষ্টা করি?',
      { status: 'error', toolName: 'audit_product_seo', errorCode: 'invalid_args' },
    )).toBe(false)
  })
})
