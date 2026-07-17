/**
 * Roadmap 1 Phase 37 — GraphHealthPanel (server component).
 *
 * The owner's one-screen answer to "LangGraph এখন কতটা চালু আর কতটা নিরাপদ":
 * ladder stage, six independent kill switches, shadow/owner-graph agreement,
 * rollback signals, checkpoint-store size. Rendered at /agent?monitor=graph
 * (owner-gated by the page). Read-only — flips happen via env / kv settings.
 */
import {
  getTurnGraphHealth,
  getCheckpointStoreHealth,
  getCutoverStatus,
} from '@/agent/lib/graph/graph-health'

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

const MODE_BN: Record<string, string> = {
  off: 'বন্ধ', shadow: 'শ্যাডো (দেখে, চালায় না)', on: 'চালু', preview_only: 'শুধু প্রিভিউ',
}

export default async function GraphHealthPanel() {
  const [health, store, cutover] = await Promise.all([
    getTurnGraphHealth(7).catch(() => null),
    getCheckpointStoreHealth().catch(() => null),
    getCutoverStatus(7).catch(() => null),
  ])

  return (
    <div style={{ maxWidth: 880, margin: '24px auto', padding: 16, fontFamily: 'system-ui', color: '#e6edf3', background: '#0d1117', borderRadius: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>🧬 Graph Health — রোলআউট অবস্থা</h1>
        <a href="/agent" style={{ color: '#79c0ff', fontSize: 13, textDecoration: 'none' }}>← চ্যাটে ফিরুন</a>
      </div>
      <p style={{ color: '#8b949e', fontSize: 13 }}>
        Ladder stage: <b style={{ color: '#79c0ff' }}>{cutover?.stage ?? 'shadow'}</b> · Canary: {cutover?.canaryVerdict ?? '—'}
      </p>

      <h2 style={{ fontSize: 15, marginTop: 18 }}>Kill switches (প্রতিটা আলাদা, সবগুলো AGENT_ENABLED-এর নিচে)</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          {Object.entries(cutover?.switches ?? {}).map(([k, s]) => (
            <tr key={k}>
              <td style={{ border: '1px solid #30363d', padding: '5px 9px' }}>{k}</td>
              <td style={{ border: '1px solid #30363d', padding: '5px 9px', color: '#8b949e' }}>{s.env}={s.value ?? '(unset)'}</td>
              <td style={{ border: '1px solid #30363d', padding: '5px 9px', fontWeight: 700, color: s.effective === 'on' ? '#3fb950' : s.effective === 'off' ? '#f85149' : '#d29922' }}>
                {MODE_BN[s.effective] ?? s.effective}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: 15, marginTop: 18 }}>গত ৭ দিনের শ্যাডো পারফরম্যান্স</h2>
      {health ? (
        <ul style={{ fontSize: 13, lineHeight: 1.8 }}>
          <li>Turns traced: <b>{health.turns}</b> · routine graph-handled share: <b>{pct(health.routine.handledShare)}</b></li>
          <li>LG-4 fast-path agreement: <b>{pct(health.shadow.agreeRate)}</b> ({health.shadow.agreed}/{health.shadow.scored})</li>
          <li>12-node owner-graph agreement: <b>{pct(health.ownerGraph.agreeRate)}</b> ({health.ownerGraph.agreed}/{health.ownerGraph.scored}) · trace-complete: {health.ownerGraph.traceComplete}/{health.ownerGraph.recorded}</li>
        </ul>
      ) : (
        <p style={{ color: '#8b949e', fontSize: 13 }}>এখনো ডেটা নেই (শ্যাডো ট্রাফিক জমলে দেখাবে)।</p>
      )}

      <h2 style={{ fontSize: 15, marginTop: 18 }}>Auto-rollback signals (যেকোনোটা বাড়লে stage নামবে)</h2>
      <ul style={{ fontSize: 13, lineHeight: 1.8 }}>
        <li>Wrong-focus bindings: <b>{cutover?.rollbackSignals.wrongFocus ?? 0}</b></li>
        <li>Owner-graph disagreements: <b>{cutover?.rollbackSignals.ownerGraphDisagreements ?? 0}</b></li>
        <li>Fast-path disagreements: <b>{cutover?.rollbackSignals.fastPathDisagreements ?? 0}</b></li>
        <li>Commitment-ledger violations: <b>{cutover?.rollbackSignals.ledgerViolations ?? 0}</b></li>
      </ul>

      <h2 style={{ fontSize: 15, marginTop: 18 }}>Checkpoint store</h2>
      <p style={{ fontSize: 13 }}>
        {store
          ? <>থ্রেড {store.totalThreads} · চেকপয়েন্ট {store.totalCheckpoints} · পরিবার: {Object.entries(store.threadFamilies).map(([f, n]) => `${f}:${n}`).join(' · ')}</>
          : 'স্টোর বন্ধ / ডেটা নেই।'}
      </p>
      <p style={{ color: '#8b949e', fontSize: 12, marginTop: 16 }}>
        রোলআউট নিয়ম: docs/agent-audit/phase-37-cutover.md — শ্যাডো → synthetic → প্রিভিউ canary → 1% → 10% → 25% → 50% → 100% (low-risk) → staged writes (Roadmap 3 gates-এর পরে)। Legacy path ৩০ দিন স্থিতিশীল ট্রাফিকের আগে সরানো নিষেধ।
      </p>
    </div>
  )
}
