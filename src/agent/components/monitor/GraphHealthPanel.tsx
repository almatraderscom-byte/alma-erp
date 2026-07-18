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
import { getProductionTruth, type EffectiveMode } from '@/agent/lib/production-truth'
import { computeOwnerBenefitScorecard } from '@/agent/lib/owner-benefit-scorecard'

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

const MODE_BN: Record<string, string> = {
  off: 'বন্ধ', shadow: 'শ্যাডো (দেখে, চালায় না)', on: 'চালু', preview_only: 'শুধু প্রিভিউ',
}

// Phase 61 — six honest states for the feature truth matrix. Only `live` is
// green; `unknown`/`broken` are red; nothing amber is mistaken for a pass.
const TRUTH_MODE: Record<EffectiveMode, { bn: string; color: string }> = {
  live: { bn: 'চালু ও ব্যবহৃত', color: '#3fb950' },
  shadow: { bn: 'শ্যাডো', color: '#d29922' },
  off: { bn: 'বন্ধ', color: '#8b949e' },
  unwired: { bn: 'কোড আছে, সংযোগ নেই', color: '#f85149' },
  broken: { bn: 'ভাঙা', color: '#f85149' },
  unused: { bn: 'চালু, ব্যবহার নেই', color: '#d29922' },
  unknown: { bn: 'অজানা', color: '#f85149' },
}

function ago(iso: string | null): string {
  if (!iso) return '—'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 60) return `${mins} মিনিট আগে`
  if (mins < 1440) return `${Math.round(mins / 60)} ঘণ্টা আগে`
  return `${Math.round(mins / 1440)} দিন আগে`
}

export default async function GraphHealthPanel() {
  const [health, store, cutover, truth, scorecard] = await Promise.all([
    getTurnGraphHealth(7).catch(() => null),
    getCheckpointStoreHealth().catch(() => null),
    getCutoverStatus(7).catch(() => null),
    getProductionTruth().catch(() => null),
    computeOwnerBenefitScorecard(7).catch(() => null),
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

      {/* Phase 61 — Release identity + feature truth matrix. Distinguishes
          merged / deployed / reachable / enabled-used / outcome so no feature
          reads "done" from a green name alone. */}
      <h2 style={{ fontSize: 15, marginTop: 18 }}>🏷️ এই বিল্ডের পরিচয় (release identity)</h2>
      {truth ? (
        <div style={{ fontSize: 13, lineHeight: 1.8, background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '10px 12px' }}>
          <div>SHA: <b style={{ color: truth.release.shaProven ? '#3fb950' : '#f85149' }}>{truth.release.app.commitShort ?? 'unknown (local/preview)'}</b> · env: <b>{truth.release.app.environment}</b>{truth.release.app.branch ? <> · branch: {truth.release.app.branch}</> : null}</div>
          <div>Migration head: <b>{truth.release.migrationHead === 'unknown' ? 'unknown' : truth.release.migrationHead.name}</b></div>
          <div>Workers: {truth.release.workers.length === 0 ? 'কোনো heartbeat নেই' : truth.release.workers.map((w) => `${w.service} (${w.alive ? 'live' : `${w.ageMinutes ?? '—'}m`})`).join(' · ')} <span style={{ color: '#8b949e' }}>· worker SHA: unknown</span></div>
        </div>
      ) : (
        <p style={{ color: '#8b949e', fontSize: 13 }}>Production truth পড়া যায়নি।</p>
      )}

      {scorecard && (
        <>
          <h2 style={{ fontSize: 15, marginTop: 18 }}>🎯 মালিক-লাভ স্কোরকার্ড (গত ৭ দিন)</h2>
          <div style={{ fontSize: 13, lineHeight: 1.9, background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '10px 12px' }}>
            <div>ধারাবাহিকতা: <b>{scorecard.continuity.scoredTurns}</b> টার্ন স্কোর করা · সঠিক binding <b style={{ color: scorecard.continuity.meetsGate ? '#3fb950' : '#d29922' }}>{(scorecard.continuity.correctBindingRate * 100).toFixed(1)}%</b> · Boss সংশোধন করেছেন <b>{scorecard.continuity.ownerCorrections}</b> বার</div>
            <div>অটোনমি: সক্রিয় শ্রেণি <b>{scorecard.autonomy.activeClasses}</b> · ডুপ্লিকেট effect <b style={{ color: scorecard.autonomy.duplicateExternalEffects ? '#f85149' : '#3fb950' }}>{scorecard.autonomy.duplicateExternalEffects}</b> · অজানা effect <b style={{ color: scorecard.autonomy.unknownEffects ? '#f85149' : '#3fb950' }}>{scorecard.autonomy.unknownEffects}</b></div>
            <div>ব্যবসায়িক ফলাফল (COD/refund/profit): <b style={{ color: '#8b949e' }}>অজানা — সত্যিকারের data ছাড়া ROI বানানো হয় না</b></div>
            {scorecard.rollbackActions.length > 0 && (
              <div style={{ color: '#f85149' }}>⚠️ স্বয়ংক্রিয় rollback: {scorecard.rollbackActions.map((a) => a.reason).join('; ')}</div>
            )}
            {scorecard.topBlockers.length > 0 && (
              <div style={{ color: '#8b949e' }}>শীর্ষ ব্লকার: {scorecard.topBlockers.join(' · ')}</div>
            )}
          </div>
        </>
      )}

      {truth && (
        <>
          <h2 style={{ fontSize: 15, marginTop: 18 }}>
            📊 ফিচার সত্য-ম্যাট্রিক্স —
            <span style={{ color: '#3fb950' }}> {truth.summary.live} live</span> ·
            <span style={{ color: '#d29922' }}> {truth.summary.shadow + truth.summary.unused} শ্যাডো/অব্যবহৃত</span> ·
            <span style={{ color: '#f85149' }}> {truth.summary.unwired + truth.summary.broken + truth.summary.unknown} সংযোগহীন/ভাঙা/অজানা</span> ·
            <span style={{ color: '#8b949e' }}> {truth.summary.off} বন্ধ</span>
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#8b949e', textAlign: 'left' }}>
                <th style={{ padding: '4px 8px' }}>ফিচার</th>
                <th style={{ padding: '4px 8px' }}>অবস্থা</th>
                <th style={{ padding: '4px 8px' }}>৭ দিনে</th>
                <th style={{ padding: '4px 8px' }}>শেষ ব্যবহার</th>
                <th style={{ padding: '4px 8px' }}>ব্লকার</th>
              </tr>
            </thead>
            <tbody>
              {truth.features.map((f) => (
                <tr key={f.id}>
                  <td style={{ border: '1px solid #30363d', padding: '5px 8px', fontWeight: 600 }}>{f.labelBn}</td>
                  <td style={{ border: '1px solid #30363d', padding: '5px 8px', fontWeight: 700, color: TRUTH_MODE[f.effectiveMode].color, whiteSpace: 'nowrap' }}>
                    {TRUTH_MODE[f.effectiveMode].bn}
                  </td>
                  <td style={{ border: '1px solid #30363d', padding: '5px 8px', textAlign: 'right' }}>{f.use7d}</td>
                  <td style={{ border: '1px solid #30363d', padding: '5px 8px', color: '#8b949e', whiteSpace: 'nowrap' }}>{ago(f.lastRealUse)}</td>
                  <td style={{ border: '1px solid #30363d', padding: '5px 8px', color: '#8b949e' }}>{f.blocker ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ color: '#8b949e', fontSize: 11, marginTop: 6 }}>
            নিয়ম: শুধু “চালু ও ব্যবহৃত” = সবুজ। “অজানা/ভাঙা/সংযোগহীন” সবসময় লাল — কোনো config মিসিং থাকলে কখনো সবুজ দেখাবে না।
          </p>
        </>
      )}

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
