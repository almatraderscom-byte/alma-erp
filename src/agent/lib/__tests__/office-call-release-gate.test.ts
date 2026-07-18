import { describe, expect, it } from 'vitest'
import {
  createOfficeCallReleaseTemplate,
  evaluateOfficeCallReleaseEvidence,
  OFFICE_CALL_RELEASE_PAIRS,
} from '../../../../scripts/office-call-release-gate.mjs'

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`

function completeEvidence() {
  const evidence = createOfficeCallReleaseTemplate()
  evidence.releaseSha = 'release-sha'
  evidence.backendSha = 'release-sha'
  evidence.deployment = { url: 'https://preview.example.test', verifiedSha: 'release-sha' }
  evidence.ios = { build: '100', embeddedSha: 'release-sha', releaseSigned: true }
  evidence.android = { build: '100', embeddedSha: 'release-sha', releaseSigned: true }
  evidence.web = { buildSha: 'release-sha' }
  evidence.dependencySecurity = { status: 'CLOSED', owner: '', rationale: '', compensatingControls: [] }
  evidence.matrixRows = evidence.matrixRows.map((row: Record<string, any>, index: number) => ({
    ...row,
    callId: uuid(index + 1),
    result: 'PASS',
    assertions: Object.fromEntries(Object.keys(row.assertions).map((key) => [key, true])),
    serverEventIds: [`event-${index}`],
    deviceLogRefs: [`log-${index}`],
    mediaRef: `video-${index}`,
  }))
  evidence.soakCalls = Array.from({ length: 100 }, (_, index) => ({
    callId: uuid(index + 1_000),
    pair: OFFICE_CALL_RELEASE_PAIRS[index % OFFICE_CALL_RELEASE_PAIRS.length],
    result: 'PASS',
    historyCorrect: true,
    eventLedgerComplete: true,
    stuckUiOrNotification: false,
    twoWayAudio: true,
  }))
  evidence.longCall = {
    callId: uuid(9_999), durationSec: 3_700, tokenRenewed: true, twoWayAudioPreserved: true,
    terminalHistoryCorrect: true, eventLedgerComplete: true,
  }
  evidence.baseline = { pushToRingP95Ms: 4_000, answerToAudioP95Ms: 2_500, endPropagationP95Ms: 1_500 }
  evidence.canary = {
    calls: 100, pushToRingP95Ms: 4_100, answerToAudioP95Ms: 2_600, endPropagationP95Ms: 1_600,
    stuckCalls: 0, correctTerminalRate: 1, backgroundSurvivalRate: 1,
  }
  evidence.rollbackDrill = {
    durationSec: 90, killSwitchBlockedNewCall: true, activeCallPolicyVerified: true,
    restoreSucceeded: true, evidenceRef: 'rollback-log-1',
  }
  evidence.ownerApproval = { approved: true, owner: 'owner', timestamp: '2026-07-18T00:00:00Z', note: 'approved' }
  return evidence
}

describe('Office call Phase 8 release gate', () => {
  it('keeps an empty template closed and enumerates every bidirectional matrix row', () => {
    const verdict = evaluateOfficeCallReleaseEvidence(createOfficeCallReleaseTemplate())
    expect(verdict.pass).toBe(false)
    expect(verdict.expectedMatrixRows).toBe(264)
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'security:dependency_exception_open',
      'soak:insufficient_calls:0/100',
      'approval:explicit_owner_approval_missing',
    ]))
  })

  it('passes only complete signed-artifact, matrix, soak, canary, rollback and owner evidence', () => {
    expect(evaluateOfficeCallReleaseEvidence(completeEvidence())).toMatchObject({
      pass: true,
      expectedMatrixRows: 264,
      suppliedMatrixRows: 264,
      soakCalls: 100,
      reasons: [],
    })
  })

  it('fails an SLO regression, a missing assertion, duplicate soak evidence or open risk', () => {
    const evidence = completeEvidence()
    evidence.canary.pushToRingP95Ms = 6_000
    evidence.matrixRows[0].assertions.twoWayAudio = false
    evidence.soakCalls[1].callId = evidence.soakCalls[0].callId
    evidence.dependencySecurity.status = 'OPEN'
    const verdict = evaluateOfficeCallReleaseEvidence(evidence)
    expect(verdict.pass).toBe(false)
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'canary:push_to_ring_p95_ms:over_5000',
      'matrix:twoWayAudio:iphone-a__iphone-b|both_foreground',
      `soak:duplicate_call:${evidence.soakCalls[0].callId}`,
      'security:dependency_exception_open',
    ]))
  })
})

