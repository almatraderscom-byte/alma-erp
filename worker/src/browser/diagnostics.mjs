/**
 * Phase 48 — guarded browser diagnostics for the VPS runner.
 * Pure functions over collected console/network/error data — no page access
 * here, so nothing to inject into. Summaries are capped: diagnostics inform,
 * they never flood the result JSON.
 */

/** Summarize collected console entries — errors first, capped. */
export function summarizeConsole(entries, maxItems = 10) {
  const list = Array.isArray(entries) ? entries : []
  const errors = list.filter((e) => e.type === 'error')
  const warnings = list.filter((e) => e.type === 'warning')
  const cap = (arr) =>
    arr.slice(0, maxItems).map((e) => ({ type: e.type, text: String(e.text ?? '').slice(0, 200) }))
  return {
    errorCount: errors.length,
    warningCount: warnings.length,
    totalCount: list.length,
    samples: cap([...errors, ...warnings]),
  }
}

/** Summarize network activity: failures + redirect chain, capped. */
export function summarizeNetwork(requests, maxItems = 10) {
  const list = Array.isArray(requests) ? requests : []
  const failures = list.filter((r) => r.failed || (r.status ?? 0) >= 400)
  const redirects = list.filter((r) => (r.status ?? 0) >= 300 && (r.status ?? 0) < 400)
  return {
    totalRequests: list.length,
    failureCount: failures.length,
    redirectCount: redirects.length,
    failures: failures.slice(0, maxItems).map((r) => ({
      url: String(r.url ?? '').slice(0, 200),
      status: r.status ?? null,
      errorText: r.errorText ? String(r.errorText).slice(0, 120) : null,
    })),
    redirects: redirects.slice(0, maxItems).map((r) => ({
      url: String(r.url ?? '').slice(0, 200),
      status: r.status ?? null,
      location: r.location ? String(r.location).slice(0, 200) : null,
    })),
  }
}

/**
 * Classify a runner failure: owner-fixable vs vendor/platform vs our-bug.
 * Mirror of src/agent/lib/browser/diagnostics.ts (worker cannot import TS).
 */
export function classifyFailure(error) {
  const e = String(error ?? '').toLowerCase()
  const mk = (kind, ownerFixable, retryable) => ({ kind, ownerFixable, retryable })

  if (/err_name_not_resolved|enotfound|dns|err_internet_disconnected|err_connection_refused|econnrefused/.test(e)) return mk('offline_dns', false, true)
  if (/err_cert|certificate|ssl|tls/.test(e)) return mk('tls', false, false)
  if (/http 5\d\d|status.?5\d\d| 5\d\d[^0-9]|internal server error|bad gateway|service unavailable/.test(e)) return mk('http_5xx', false, true)
  if (/session (expired|invalid)|logged out|sign.?in again|401|unauthorized|token.*(expired|invalid)/.test(e)) return mk('auth_expired', true, false)
  if (/403|forbidden|permission denied|not authorized|access denied/.test(e)) return mk('permission_denied', true, false)
  if (/deprecated|no longer supported|unsupported api version/.test(e)) return mk('api_deprecated', false, false)
  if (/upload (failed|error)|file too large|processing failed/.test(e)) return mk('upload_failed', false, true)
  if (/(selector|locator|element).*(not found|timeout|detached)|no element matches|waiting for selector/.test(e)) return mk('selector_broken', false, false)
  if (/task_timeout|timeout|timed out|deadline/.test(e)) return mk('timeout', false, true)
  if (/http 4\d\d|status.?4\d\d| 4\d\d[^0-9]|not found|bad request/.test(e)) return mk('http_4xx', false, false)
  return mk('unknown', false, false)
}

/**
 * Evaluate task success criteria against the final page state.
 * Mirror of evaluateCriteria in src/agent/lib/browser/success-criteria.ts.
 */
export function evaluateSuccessCriteria(criteria, state) {
  const list = Array.isArray(criteria) ? criteria : []
  const results = list.map((criterion) => {
    const kind = String(criterion?.kind ?? '')
    if (kind === 'url_matches') {
      let passed = false
      try {
        passed = new RegExp(criterion.pattern).test(state.url ?? '')
      } catch {
        passed = false
      }
      return { criterion, passed, detail: passed ? 'url matches' : `url "${state.url}" !~ /${criterion.pattern}/` }
    }
    if (kind === 'selector_exists') {
      const passed = (state.presentSelectors ?? []).includes(criterion.selector)
      return { criterion, passed, detail: passed ? 'selector found' : `selector "${criterion.selector}" absent` }
    }
    if (kind === 'text_present') {
      const passed = (state.visibleText ?? '').includes(criterion.text)
      return { criterion, passed, detail: passed ? 'text found' : 'text missing on final page' }
    }
    if (kind === 'text_absent') {
      const passed = !(state.visibleText ?? '').includes(criterion.text)
      return { criterion, passed, detail: passed ? 'text correctly absent' : 'forbidden text present' }
    }
    return { criterion, passed: false, detail: `unknown criterion kind "${kind}"` }
  })
  return { passed: results.length > 0 && results.every((r) => r.passed), results }
}
