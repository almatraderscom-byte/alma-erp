#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const OFFICE_CALL_RELEASE_PAIRS = [
  'iphone-a__iphone-b',
  'iphone-b__iphone-a',
  'android-a__android-b',
  'android-b__android-a',
  'iphone__android',
  'android__iphone',
  'web__iphone',
  'iphone__web',
  'web__android',
  'android__web',
  'web-a__web-b',
  'web-b__web-a',
]

export const OFFICE_CALL_RELEASE_SCENARIOS = [
  'both_foreground',
  'callee_other_app_screen',
  'callee_backgrounded',
  'callee_locked',
  'callee_process_killed',
  'caller_cancels_before_answer',
  'callee_declines_system_or_app_ui',
  'callee_answers_system_or_app_ui',
  'caller_and_callee_hangup',
  'server_missed_timeout',
  'callee_busy',
  'notification_or_fullscreen_denied',
  'microphone_denied_then_restored',
  'wifi_cellular_handoff',
  'network_loss_5s_15s_over_policy',
  'wired_bluetooth_speaker_earpiece',
  'gsm_or_voip_interruption',
  'callee_two_devices_answer_one',
  'logout_or_account_switch',
  'duplicate_late_out_of_order',
  'token_renewal_long_call',
  'navigate_minimize_return',
]

export const OFFICE_CALL_ROW_ASSERTIONS = [
  'serverState',
  'callerState',
  'calleeState',
  'systemUiCleared',
  'agoraMembership',
  'twoWayAudio',
  'historyCorrect',
  'eventLedgerComplete',
]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function expectedOfficeCallMatrixKeys() {
  return OFFICE_CALL_RELEASE_PAIRS.flatMap((pair) =>
    OFFICE_CALL_RELEASE_SCENARIOS.map((scenario) => `${pair}|${scenario}`),
  )
}

function blankRow(pair, scenario) {
  return {
    pair,
    scenario,
    callId: '',
    result: 'PENDING',
    assertions: Object.fromEntries(OFFICE_CALL_ROW_ASSERTIONS.map((assertion) => [assertion, false])),
    serverEventIds: [],
    deviceLogRefs: [],
    mediaRef: '',
    notes: '',
  }
}

export function createOfficeCallReleaseTemplate() {
  return {
    releaseSha: '',
    backendSha: '',
    deployment: { url: '', verifiedSha: '' },
    ios: { build: '', embeddedSha: '', releaseSigned: false },
    android: { build: '', embeddedSha: '', releaseSigned: false },
    web: { buildSha: '' },
    dependencySecurity: { status: 'OPEN', owner: '', rationale: '', compensatingControls: [] },
    matrixRows: OFFICE_CALL_RELEASE_PAIRS.flatMap((pair) =>
      OFFICE_CALL_RELEASE_SCENARIOS.map((scenario) => blankRow(pair, scenario)),
    ),
    soakCalls: [],
    longCall: {
      callId: '', durationSec: 0, tokenRenewed: false, twoWayAudioPreserved: false,
      terminalHistoryCorrect: false, eventLedgerComplete: false,
    },
    baseline: null,
    canary: null,
    rollbackDrill: {
      durationSec: 0, killSwitchBlockedNewCall: false, activeCallPolicyVerified: false,
      restoreSucceeded: false, evidenceRef: '',
    },
    ownerApproval: { approved: false, owner: '', timestamp: '', note: '' },
  }
}

function present(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateSlo(name, value, limit, reasons) {
  if (!finite(value)) reasons.push(`${name}:missing`)
  else if (value > limit) reasons.push(`${name}:over_${limit}`)
}

export function evaluateOfficeCallReleaseEvidence(evidence) {
  const reasons = []
  const releaseSha = evidence?.releaseSha
  if (!present(releaseSha)) reasons.push('artifact:release_sha_missing')
  for (const [name, value] of [
    ['backend', evidence?.backendSha],
    ['deployment', evidence?.deployment?.verifiedSha],
    ['ios', evidence?.ios?.embeddedSha],
    ['android', evidence?.android?.embeddedSha],
    ['web', evidence?.web?.buildSha],
  ]) {
    if (!present(value) || value !== releaseSha) reasons.push(`artifact:${name}_sha_mismatch`)
  }
  if (!present(evidence?.deployment?.url) || !String(evidence.deployment.url).startsWith('https://')) {
    reasons.push('artifact:deployment_url_invalid')
  }
  if (!evidence?.ios?.releaseSigned || !present(evidence?.ios?.build)) reasons.push('artifact:ios_release_build_missing')
  if (!evidence?.android?.releaseSigned || !present(evidence?.android?.build)) reasons.push('artifact:android_release_build_missing')

  const dependencyStatus = evidence?.dependencySecurity?.status
  if (!['CLOSED', 'OWNER_ACCEPTED'].includes(dependencyStatus)) reasons.push('security:dependency_exception_open')
  if (dependencyStatus === 'OWNER_ACCEPTED') {
    if (!present(evidence?.dependencySecurity?.owner) || !present(evidence?.dependencySecurity?.rationale)) {
      reasons.push('security:risk_acceptance_incomplete')
    }
    if (!Array.isArray(evidence?.dependencySecurity?.compensatingControls)
      || evidence.dependencySecurity.compensatingControls.length === 0) {
      reasons.push('security:compensating_controls_missing')
    }
  }

  const rows = Array.isArray(evidence?.matrixRows) ? evidence.matrixRows : []
  const expected = new Set(expectedOfficeCallMatrixKeys())
  const seen = new Set()
  for (const row of rows) {
    const key = `${row?.pair}|${row?.scenario}`
    if (!expected.has(key)) {
      reasons.push(`matrix:unexpected:${key}`)
      continue
    }
    if (seen.has(key)) reasons.push(`matrix:duplicate:${key}`)
    seen.add(key)
    if (row?.result !== 'PASS') reasons.push(`matrix:not_passed:${key}`)
    if (!UUID_RE.test(row?.callId ?? '')) reasons.push(`matrix:call_id_missing:${key}`)
    for (const assertion of OFFICE_CALL_ROW_ASSERTIONS) {
      if (row?.assertions?.[assertion] !== true) reasons.push(`matrix:${assertion}:${key}`)
    }
    if (!Array.isArray(row?.serverEventIds) || row.serverEventIds.length === 0) reasons.push(`matrix:server_events:${key}`)
    if (!Array.isArray(row?.deviceLogRefs) || row.deviceLogRefs.length === 0) reasons.push(`matrix:device_logs:${key}`)
    if (!present(row?.mediaRef)) reasons.push(`matrix:media_ref:${key}`)
  }
  for (const key of expected) if (!seen.has(key)) reasons.push(`matrix:missing:${key}`)

  const soak = Array.isArray(evidence?.soakCalls) ? evidence.soakCalls : []
  if (soak.length < 100) reasons.push(`soak:insufficient_calls:${soak.length}/100`)
  const soakIds = new Set()
  const soakPairs = new Set()
  for (const call of soak) {
    if (!UUID_RE.test(call?.callId ?? '')) reasons.push('soak:call_id_missing')
    else if (soakIds.has(call.callId)) reasons.push(`soak:duplicate_call:${call.callId}`)
    else soakIds.add(call.callId)
    if (OFFICE_CALL_RELEASE_PAIRS.includes(call?.pair)) soakPairs.add(call.pair)
    else reasons.push(`soak:invalid_pair:${call?.pair ?? 'missing'}`)
    if (call?.result !== 'PASS' || call?.historyCorrect !== true || call?.eventLedgerComplete !== true
      || call?.stuckUiOrNotification !== false || call?.twoWayAudio !== true) {
      reasons.push(`soak:failed:${call?.callId ?? 'missing'}`)
    }
  }
  for (const pair of OFFICE_CALL_RELEASE_PAIRS) if (!soakPairs.has(pair)) reasons.push(`soak:pair_missing:${pair}`)

  const longCall = evidence?.longCall
  if (!UUID_RE.test(longCall?.callId ?? '') || !finite(longCall?.durationSec) || longCall.durationSec <= 3_600
    || longCall?.tokenRenewed !== true || longCall?.twoWayAudioPreserved !== true
    || longCall?.terminalHistoryCorrect !== true || longCall?.eventLedgerComplete !== true) {
    reasons.push('soak:long_call_token_renewal_incomplete')
  }

  const candidate = evidence?.canary
  const baseline = evidence?.baseline
  if (!candidate || !baseline) reasons.push('canary:baseline_or_candidate_missing')
  else {
    if (!finite(candidate.calls) || candidate.calls < 100) reasons.push('canary:insufficient_calls')
    validateSlo('canary:push_to_ring_p95_ms', candidate.pushToRingP95Ms, 5_000, reasons)
    validateSlo('canary:answer_to_audio_p95_ms', candidate.answerToAudioP95Ms, 3_000, reasons)
    validateSlo('canary:end_propagation_p95_ms', candidate.endPropagationP95Ms, 2_000, reasons)
    if (candidate.stuckCalls !== 0) reasons.push('canary:stuck_calls_nonzero')
    if (candidate.correctTerminalRate !== 1) reasons.push('canary:terminal_history_not_100pct')
    if (candidate.backgroundSurvivalRate !== 1) reasons.push('canary:background_survival_not_100pct')
    for (const metric of ['pushToRingP95Ms', 'answerToAudioP95Ms', 'endPropagationP95Ms']) {
      if (finite(candidate[metric]) && finite(baseline[metric]) && candidate[metric] > baseline[metric] * 1.1) {
        reasons.push(`canary:regressed:${metric}`)
      }
    }
  }

  const rollback = evidence?.rollbackDrill
  if (!finite(rollback?.durationSec) || rollback.durationSec > 300
    || rollback?.killSwitchBlockedNewCall !== true || rollback?.activeCallPolicyVerified !== true
    || rollback?.restoreSucceeded !== true || !present(rollback?.evidenceRef)) {
    reasons.push('rollback:drill_incomplete_or_over_300s')
  }

  if (evidence?.ownerApproval?.approved !== true || !present(evidence?.ownerApproval?.owner)
    || !present(evidence?.ownerApproval?.timestamp) || !present(evidence?.ownerApproval?.note)) {
    reasons.push('approval:explicit_owner_approval_missing')
  }

  const uniqueReasons = [...new Set(reasons)]
  return {
    pass: uniqueReasons.length === 0,
    expectedMatrixRows: expected.size,
    suppliedMatrixRows: rows.length,
    soakCalls: soak.length,
    reasons: uniqueReasons,
  }
}

function main() {
  const target = process.argv[2]
  if (target === '--template') {
    process.stdout.write(`${JSON.stringify(createOfficeCallReleaseTemplate(), null, 2)}\n`)
    return
  }
  if (!target) {
    process.stderr.write('Usage: node scripts/office-call-release-gate.mjs --template | <evidence.json>\n')
    process.exitCode = 2
    return
  }
  const evidence = JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'))
  const verdict = evaluateOfficeCallReleaseEvidence(evidence)
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  if (!verdict.pass) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()

