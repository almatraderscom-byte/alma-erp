'use client'

import type {
  EditorActor,
  EditorCommandReceipt,
  EditorOperationProposal,
  EditorPendingAction,
} from '@/lib/creative-studio/editor-agent'
import { shortPlanFingerprint } from '@/lib/creative-studio/editor-agent'
import { EditorIcon } from './EditorIcon'
import type { PendingActionRequestHandler } from './ui-types'
import styles from './ProjectEditor.module.css'

function diffValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key} ${typeof entry === 'number' ? Math.round(entry * 1_000) / 1_000 : String(entry)}`)
      .join(' · ')
  }
  return String(value ?? '—')
}

function pendingReason(action: EditorPendingAction): string {
  const reasons: Record<
    NonNullable<EditorPendingAction['blockedReason']>,
    string
  > = {
    provider_unavailable: 'Provider unavailable · blocked',
    provider_disabled: 'Provider disabled · blocked',
    invalid_cost: 'Invalid cost evidence · blocked',
    cost_cap_exceeded: 'Cost cap exceeded · blocked',
    voice_inactive: 'Voice version inactive · blocked',
    voice_revoked: 'Voice version revoked · blocked',
    voice_not_consented: 'Voice consent inactive · blocked',
    external_effect_not_allowed: 'External effect blocked',
    separate_render_required: 'Separate render command required',
  }
  return action.blockedReason
    ? reasons[action.blockedReason]
    : 'Separate owner confirmation'
}

export function CreativeAgentPanel({
  acknowledged,
  actor,
  busy,
  currentVersion,
  instruction,
  lastReceipt,
  onAcknowledgedChange,
  onApply,
  onInstructionChange,
  onPlan,
  onRequestPendingAction,
  proposal,
  stale,
}: {
  acknowledged: boolean
  actor: EditorActor
  busy: boolean
  currentVersion: number
  instruction: string
  lastReceipt: EditorCommandReceipt | null
  onAcknowledgedChange: (acknowledged: boolean) => void
  onApply: () => void
  onInstructionChange: (instruction: string) => void
  onPlan: () => void
  onRequestPendingAction?: PendingActionRequestHandler
  proposal: EditorOperationProposal | null
  stale: boolean
}) {
  const shortFingerprint = proposal
    ? shortPlanFingerprint(proposal.fingerprint)
    : null
  const canAcknowledge = Boolean(
    proposal
    && !proposal.requiresClarification
    && !stale
    && actor.role === 'owner',
  )
  const canApply = Boolean(
    proposal
    && proposal.operations.length > 0
    && acknowledged
    && canAcknowledge
    && !busy,
  )

  return (
    <div className={styles.agentPanel}>
      <header className={styles.agentIdentity}>
        <span className={styles.agentIdentityMark}>
          <EditorIcon name="agent" size={20} />
        </span>
        <div>
          <span>CREATIVE AGENT</span>
          <strong>Plan before change</strong>
          <small>Deterministic · version-bound · reversible apply</small>
        </div>
        <span className={styles.agentMode}>
          <EditorIcon name="lock" size={11} />
          PLAN
        </span>
      </header>

      <section className={styles.agentContextStrip}>
        <span>
          <small>COMPOSITION</small>
          <strong>v{currentVersion}</strong>
        </span>
        <i />
        <span>
          <small>ROLE</small>
          <strong>{actor.role}</strong>
        </span>
        <i />
        <span>
          <small>LOCAL APPLY</small>
          <strong>৳0 only</strong>
        </span>
      </section>

      {!proposal ? (
        <section className={styles.agentEmpty}>
          <span>
            <EditorIcon name="agent" size={24} />
          </span>
          <h3>Describe the outcome. Review every operation.</h3>
          <p>
            বাংলা বা English-এ caption, trim, split, transform ও volume বলুন।
            Paid generation, voice, render/export এবং publish আলাদা থাকবে।
          </p>
          <div>
            <button
              onClick={() => onInstructionChange('Opening shotটা tighter করো, caption beat-এ আনো, voice-এর নিচে music 12% করো। Paid বা publish কিছু কোরো না।')}
              type="button"
            >
              Tight opening + mix
            </button>
            <button
              onClick={() => onInstructionChange('ক্যাপশন ১.২ সেকেন্ডে নাও এবং প্লেহেডে ক্লিপ ভাগ করো।')}
              type="button"
            >
              Caption + split
            </button>
          </div>
        </section>
      ) : (
        <div className={styles.agentPlan}>
          <header className={styles.planHeader}>
            <div>
              <span>PROPOSED CHANGESET</span>
              <strong>{proposal.operations.length} local · {proposal.pendingActions.length} pending</strong>
            </div>
            <span className={styles.fingerprint}>
              <EditorIcon name="lock" size={12} />
              {shortFingerprint} · base v{proposal.expectedVersion}
            </span>
          </header>

          {stale && (
            <div className={styles.stalePlan} role="alert">
              <EditorIcon name="warning" size={16} />
              <span>
                <strong>Plan is stale.</strong>
                Composition advanced to v{currentVersion}; re-plan before acknowledgement.
              </span>
            </div>
          )}

          {proposal.warnings.length > 0 && (
            <ul className={styles.planWarnings} aria-label="Plan warnings">
              {proposal.warnings.map((warning) => (
                <li key={warning.code}>
                  <EditorIcon name="warning" size={13} />
                  <span><strong>{warning.code}</strong>{warning.message}</span>
                </li>
              ))}
            </ul>
          )}

          <section className={styles.operationGroup}>
            <header>
              <span>
                <EditorIcon name="check" size={13} />
                REVERSIBLE LOCAL OPERATIONS
              </span>
              <em>৳0 · exact diff</em>
            </header>
            {proposal.operations.length > 0 ? (
              <ol>
                {proposal.operations.map((operation, index) => (
                  <li key={operation.id}>
                    <span className={styles.operationIndex}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div>
                      <strong>{operation.label}</strong>
                      <small>
                        {operation.kind} · {operation.target.trackId}/{operation.target.clipId ?? 'track'}
                      </small>
                      <p>
                        <del>{diffValue(operation.before)}</del>
                        <span>→</span>
                        <ins>{diffValue(operation.after)}</ins>
                      </p>
                    </div>
                    <em>৳0</em>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.noOperations}>
                No local operation is eligible. Pending actions cannot use local apply.
              </p>
            )}
          </section>

          {proposal.pendingActions.length > 0 && (
            <section className={`${styles.operationGroup} ${styles.pendingGroup}`}>
              <header>
                <span>
                  <EditorIcon name="lock" size={13} />
                  SEPARATE PENDING ACTIONS
                </span>
                <em>Never in local apply</em>
              </header>
              <ol>
                {proposal.pendingActions.map((action) => (
                  <li key={action.id}>
                    <span className={styles.operationIndex}>
                      <EditorIcon name="lock" size={12} />
                    </span>
                    <div>
                      <strong>{action.label}</strong>
                      <small>
                        {action.kind} · {pendingReason(action)}
                      </small>
                      <p>
                        {action.provider?.model ?? action.destination ?? 'No execution adapter'}
                      </p>
                    </div>
                    <button
                      disabled={!onRequestPendingAction || action.state === 'blocked'}
                      onClick={() => onRequestPendingAction?.(action)}
                      type="button"
                    >
                      {action.estimatedCostBdt > 0
                        ? `est. ৳${action.estimatedCostBdt}`
                        : 'Separate'}
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className={styles.ownerAcknowledgement}>
            <label>
              <input
                checked={acknowledged}
                disabled={!canAcknowledge}
                onChange={(event) => onAcknowledgedChange(event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>
                  I reviewed {shortFingerprint} for composition v{proposal.expectedVersion}.
                </strong>
                <small>Apply only listed reversible ৳0 operations.</small>
              </span>
            </label>
            {actor.role !== 'owner' && (
              <p role="alert">Owner acknowledgement is required; prompt text cannot change this role.</p>
            )}
            <button
              className={styles.agentApplyButton}
              disabled={!canApply}
              onClick={onApply}
              type="button"
            >
              {busy ? 'Validating…' : `Apply ${proposal.operations.length} safe edit${proposal.operations.length === 1 ? '' : 's'}`}
              <EditorIcon name="chevron-right" size={16} />
            </button>
          </section>

          {lastReceipt && (
            <section className={styles.agentReceipt} role="status">
              <span>
                <EditorIcon name="check" size={16} />
              </span>
              <div>
                <strong>{lastReceipt.status.replace('_', ' ')}</strong>
                <small>{lastReceipt.auditId} · v{lastReceipt.snapshot.version}</small>
                <p>
                  {lastReceipt.operationIds.length} local operations recorded.
                  {lastReceipt.pendingActionIds.length > 0
                    ? ` ${lastReceipt.pendingActionIds.length} pending actions were not executed.`
                    : ' No paid or external action ran.'}
                </p>
              </div>
            </section>
          )}
        </div>
      )}

      <footer className={styles.agentComposer}>
        <label>
          <span className={styles.srOnly}>Creative Agent instruction</span>
          <textarea
            maxLength={4_000}
            onChange={(event) => onInstructionChange(event.target.value)}
            placeholder="যেমন: opening trim করো, caption ১.২s-এ আনো…"
            rows={4}
            value={instruction}
          />
        </label>
        <div>
          <span>
            <EditorIcon name="lock" size={12} />
            Server role + version validation remains authoritative
          </span>
          <button
            className={styles.planButton}
            disabled={busy || instruction.trim().length < 2}
            onClick={onPlan}
            type="button"
          >
            {busy ? 'Planning…' : proposal ? 'Re-plan' : 'Build plan'}
            <EditorIcon name="agent" size={15} />
          </button>
        </div>
      </footer>
    </div>
  )
}
