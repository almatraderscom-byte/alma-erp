'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import {
  applyDemoPlan,
  DEMO_AGENT_PLAN,
  DEMO_PLAN_FINGERPRINT,
  INITIAL_DEMO_STATE,
  rollbackDemoPlan,
  type DemoCompositionState,
  type DemoEffectClass,
} from '@/lib/creative-studio/demo-operations'
import styles from './CreativeStudioEnterpriseDemo.module.css'

type ToolId = 'image' | 'video' | 'voice' | 'audio' | 'library'
type WorkbenchTab = 'inspector' | 'agent' | 'review'
type AgentPhase = 'idle' | 'planned' | 'applied' | 'rolled_back'

type AssetFixture = {
  id: string
  name: string
  meta: string
  type: 'image' | 'video' | 'voice' | 'music' | 'sfx'
  tone: 'coral' | 'sand' | 'teal' | 'violet' | 'amber'
  status: string
}

const tools: ReadonlyArray<{ id: ToolId; glyph: string; label: string }> = [
  { id: 'image', glyph: '◇', label: 'Image' },
  { id: 'video', glyph: '▶', label: 'Video' },
  { id: 'voice', glyph: '◉', label: 'Voice' },
  { id: 'audio', glyph: '♫', label: 'Audio' },
  { id: 'library', glyph: '▦', label: 'Library' },
]

const assetFixtures: readonly AssetFixture[] = [
  {
    id: 'hero',
    name: 'Coral Panjabi · Hero',
    meta: 'Image · 1080 × 1350',
    type: 'image',
    tone: 'coral',
    status: 'QC passed',
  },
  {
    id: 'family',
    name: 'Father + Son · Select 02',
    meta: 'Image · Recipe v7',
    type: 'image',
    tone: 'sand',
    status: 'Approved',
  },
  {
    id: 'turn',
    name: 'Fabric turn · 6 sec',
    meta: 'Video · 9:16',
    type: 'video',
    tone: 'teal',
    status: 'Ready',
  },
  {
    id: 'owner-voice',
    name: 'Owner voice · Active v3',
    meta: 'Voice · consent pinned',
    type: 'voice',
    tone: 'violet',
    status: 'Owner only',
  },
  {
    id: 'eid-theme',
    name: 'Eid pulse · Approved',
    meta: 'Music · 00:24',
    type: 'music',
    tone: 'amber',
    status: 'Licensed',
  },
]

const toolCopy: Record<ToolId, { eyebrow: string; title: string; hint: string }> = {
  image: {
    eyebrow: 'CREATE',
    title: 'Image',
    hint: 'Auto, Advanced, Campaign Pack and finishing',
  },
  video: {
    eyebrow: 'EDIT',
    title: 'Video',
    hint: 'Reels, owned shoots and AI video',
  },
  voice: {
    eyebrow: 'SPEAK',
    title: 'Voice',
    hint: 'Approved voices, dubbing and transcript',
  },
  audio: {
    eyebrow: 'SOUND',
    title: 'Music + SFX',
    hint: 'Owner-approved library and generated audio',
  },
  library: {
    eyebrow: 'REUSE',
    title: 'Library',
    hint: 'Assets, models, voices and recipes',
  },
}

const captionWords = [
  { id: 'w1', text: 'ঈদের', at: '00:01.2' },
  { id: 'w2', text: 'নতুন', at: '00:01.8' },
  { id: 'w3', text: 'গল্প', at: '00:02.5' },
] as const

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  const tenths = Math.floor((safe % 1) * 10)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`
}

function effectLabel(effect: DemoEffectClass): string {
  if (effect === 'paid_generation') return 'Paid generation'
  if (effect === 'external_publish') return 'External effect'
  return '$0 local edit'
}

export function CreativeStudioEnterpriseDemo() {
  const [activeTool, setActiveTool] = useState<ToolId>('video')
  const [selectedAsset, setSelectedAsset] = useState('hero')
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>('agent')
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [agentPhase, setAgentPhase] = useState<AgentPhase>('idle')
  const [instruction, setInstruction] = useState(
    'Opening shotটা tighter করো, caption beat-এ আনো, voice-এর নিচে music কমাও। Paid বা publish কিছু কোরো না।',
  )
  const [approved, setApproved] = useState(false)
  const [composition, setComposition] = useState<DemoCompositionState>(
    INITIAL_DEMO_STATE,
  )
  const [rollbackPoint, setRollbackPoint] = useState<DemoCompositionState | null>(
    null,
  )
  const [auditId, setAuditId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(5.8)
  const [playing, setPlaying] = useState(false)
  const [timelineZoom, setTimelineZoom] = useState(72)
  const [notice, setNotice] = useState(
    'Prototype uses fixtures only. No provider, export or publish call is connected.',
  )

  useEffect(() => {
    if (!playing) return
    const interval = window.setInterval(() => {
      setPlayhead((current) => {
        const next = current + 0.1
        if (next >= composition.durationSec) {
          setPlaying(false)
          return 0
        }
        return next
      })
    }, 100)
    return () => window.clearInterval(interval)
  }, [composition.durationSec, playing])

  const selected = assetFixtures.find((asset) => asset.id === selectedAsset)
    ?? assetFixtures[0]
  const filteredAssets = activeTool === 'library'
    ? assetFixtures
    : activeTool === 'audio'
      ? assetFixtures.filter((asset) => asset.type === 'music' || asset.type === 'sfx')
      : activeTool === 'voice'
        ? assetFixtures.filter((asset) => asset.type === 'voice')
        : assetFixtures.filter((asset) => asset.type === activeTool || asset.type === 'image')
  const playheadPercent = Math.min(100, (playhead / composition.durationSec) * 100)
  const canvasStyle = {
    '--playhead-position': `${playheadPercent}%`,
    '--playhead-offset': `${76 * (1 - playheadPercent / 100)}px`,
    '--timeline-scale': `${timelineZoom / 72}`,
  } as CSSProperties

  function createPlan() {
    setWorkbenchTab('agent')
    setWorkbenchOpen(true)
    setAgentPhase('planned')
    setApproved(false)
    setNotice('Plan created locally. Review is required before any edit can apply.')
  }

  function applyPlan() {
    if (!approved) {
      setNotice('Owner review is required for this exact plan fingerprint.')
      return
    }
    const result = applyDemoPlan(composition, DEMO_PLAN_FINGERPRINT)
    setRollbackPoint(composition)
    setComposition(result.state)
    setAuditId(result.auditId)
    setAgentPhase('applied')
    setPlayhead(Math.min(playhead, result.state.durationSec))
    setNotice('3 reversible $0 edits applied. Paid generation and publish remain blocked.')
  }

  function undoPlan() {
    if (!rollbackPoint) return
    setComposition((current) => rollbackDemoPlan(current, rollbackPoint))
    setAgentPhase('rolled_back')
    setApproved(false)
    setNotice('Rollback completed as a new audited version. No provider call was made.')
  }

  function splitAtPlayhead() {
    setComposition((current) => ({
      ...current,
      version: current.version + 1,
      clipCount: current.clipCount + 1,
    }))
    setNotice(`Clip split at ${formatTime(playhead)} · local prototype operation`)
  }

  function previewOnly(action: 'Share' | 'Export') {
    setNotice(`${action} is intentionally disconnected in this prototype. Nothing was sent.`)
  }

  return (
    <main className={styles.shell} style={canvasStyle}>
      <a className={styles.skipLink} href="#studio-stage">Skip to canvas</a>

      <header className={styles.topbar}>
        <div className={styles.brandBlock}>
          <span className={styles.brandMark}>A</span>
          <div>
            <strong>ALMA Studio</strong>
            <span>Enterprise concept</span>
          </div>
        </div>

        <div className={styles.projectCrumb}>
          <button aria-label="Back to projects" type="button">‹</button>
          <div>
            <span>ALMA Lifestyle / Eid 2026</span>
            <strong>Coral Panjabi Launch</strong>
          </div>
          <span className={styles.savedState}>● Saved</span>
        </div>

        <div className={styles.topActions}>
          <span className={styles.prototypeBadge}>INTERACTIVE PROTOTYPE · $0</span>
          <span className={styles.versionBadge}>v{composition.version}</span>
          <button
            aria-label="Undo last Creative Agent plan"
            disabled={!rollbackPoint || agentPhase === 'rolled_back'}
            onClick={undoPlan}
            type="button"
          >
            ↶
          </button>
          <button aria-label="Redo unavailable in prototype" disabled type="button">↷</button>
          <button onClick={() => previewOnly('Share')} type="button">Share</button>
          <button className={styles.exportButton} onClick={() => previewOnly('Export')} type="button">
            Export
          </button>
        </div>
      </header>

      <aside className={styles.toolRail} aria-label="Creative tools">
        <button className={styles.addButton} aria-label="Add media" type="button">+</button>
        <div className={styles.toolGroup}>
          {tools.map((tool) => (
            <button
              className={activeTool === tool.id ? styles.activeTool : undefined}
              aria-pressed={activeTool === tool.id}
              key={tool.id}
              onClick={() => {
                setActiveTool(tool.id)
                setWorkbenchOpen(false)
              }}
              type="button"
            >
              <span aria-hidden="true">{tool.glyph}</span>
              {tool.label}
            </button>
          ))}
        </div>
        <button
          className={styles.agentRailButton}
          onClick={() => {
            setWorkbenchTab('agent')
            setWorkbenchOpen(true)
          }}
          type="button"
        >
          <span aria-hidden="true">✦</span>
          Agent
        </button>
      </aside>

      <aside className={styles.assetPanel} aria-label={`${toolCopy[activeTool].title} panel`}>
        <div className={styles.panelHeading}>
          <span>{toolCopy[activeTool].eyebrow}</span>
          <h1>{toolCopy[activeTool].title}</h1>
          <p>{toolCopy[activeTool].hint}</p>
        </div>

        <div className={styles.scopeTabs} role="tablist" aria-label="Asset scope">
          <button className={styles.activeScope} role="tab" aria-selected="true" type="button">
            Project
          </button>
          <button role="tab" aria-selected="false" type="button">Workspace</button>
        </div>

        <label className={styles.searchBox}>
          <span aria-hidden="true">⌕</span>
          <span className={styles.srOnly}>Search project assets</span>
          <input placeholder="Search assets…" />
          <kbd>⌘K</kbd>
        </label>

        {activeTool !== 'library' && (
          <button
            className={styles.createCard}
            onClick={() => setNotice('Generation entry point only—no paid job was queued.')}
            type="button"
          >
            <span className={styles.createIcon}>+</span>
            <span>
              <strong>
                {activeTool === 'video'
                  ? 'Add video or AI clip'
                  : activeTool === 'audio'
                    ? 'Add approved sound'
                    : `Add ${toolCopy[activeTool].title.toLowerCase()}`}
              </strong>
              <small>Review source, model and cost first</small>
            </span>
          </button>
        )}

        <div className={styles.assetSectionHeader}>
          <strong>{activeTool === 'library' ? 'Reusable library' : 'In this project'}</strong>
          <span>{filteredAssets.length} items</span>
        </div>

        <div className={styles.assetGrid}>
          {filteredAssets.map((asset) => (
            <button
              aria-pressed={selectedAsset === asset.id}
              className={`${styles.assetCard} ${selectedAsset === asset.id ? styles.assetSelected : ''}`}
              key={asset.id}
              onClick={() => setSelectedAsset(asset.id)}
              type="button"
            >
              <span className={`${styles.assetThumb} ${styles[asset.tone]}`}>
                <span>{asset.type === 'video' ? '▶' : asset.type === 'voice' ? '≈' : asset.type === 'music' ? '♫' : 'A'}</span>
              </span>
              <span className={styles.assetDetails}>
                <strong>{asset.name}</strong>
                <small>{asset.meta}</small>
                <em>{asset.status}</em>
              </span>
            </button>
          ))}
        </div>

        <div className={styles.projectPins}>
          <span>PROJECT PINS</span>
          <button type="button"><b>Product</b><small>AL-EID-042</small></button>
          <button type="button"><b>Recipe</b><small>Editorial Warm · v7 🔒</small></button>
          <button type="button"><b>Folder</b><small>Eid / Coral launch</small></button>
        </div>
      </aside>

      <section className={styles.workspace}>
        <div className={styles.stageToolbar}>
          <div>
            <button className={styles.activeStageControl} type="button">9:16</button>
            <button
              aria-pressed={composition.safeZone}
              onClick={() => setComposition((current) => ({
                ...current,
                safeZone: !current.safeZone,
                version: current.version + 1,
              }))}
              type="button"
            >
              Safe zones {composition.safeZone ? 'on' : 'off'}
            </button>
          </div>
          <div className={styles.stageStatus}>
            <span>Preview · 1080 × 1920</span>
            <span className={styles.qcPassed}>QC passed</span>
          </div>
        </div>

        <div className={styles.stage} id="studio-stage">
          <div className={styles.canvas}>
            <div className={styles.canvasGlow} />
            <div className={styles.canvasBrand}>ALMA</div>
            <div className={styles.canvasCollection}>EID / 26</div>
            <div className={styles.modelFigure} aria-label="Stylized coral Panjabi campaign preview">
              <div className={styles.figureHead} />
              <div className={styles.figureNeck} />
              <div className={styles.garment}>
                <span />
                <i />
              </div>
            </div>
            <div className={styles.productCopy}>
              <span>NEW SEASON</span>
              <strong>Quiet confidence,<br />made for Eid.</strong>
              <small>AL-EID-042 · Coral cotton panjabi</small>
            </div>
            <div className={styles.captionOverlay}>
              {composition.caption}
            </div>
            {composition.safeZone && <div className={styles.safeZone} aria-hidden="true" />}
            <div className={styles.previewLabel}>CONCEPT PREVIEW</div>
          </div>
        </div>

        <div className={styles.transport}>
          <button aria-label="Go to start" onClick={() => setPlayhead(0)} type="button">|‹</button>
          <button
            className={styles.playButton}
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={() => setPlaying((current) => !current)}
            type="button"
          >
            {playing ? 'Ⅱ' : '▶'}
          </button>
          <button aria-label="Skip forward five seconds" onClick={() => setPlayhead((current) => (
            Math.min(composition.durationSec, current + 5)
          ))} type="button">›|</button>
          <span className={styles.timecode}>
            {formatTime(playhead)} <i>/ {formatTime(composition.durationSec)}</i>
          </span>
          <button onClick={splitAtPlayhead} type="button">Split at playhead</button>
          <div className={styles.transportSpacer} />
          <label className={styles.zoomControl}>
            <span>Timeline zoom</span>
            <input
              aria-label="Timeline zoom"
              max="100"
              min="44"
              onChange={(event) => setTimelineZoom(Number(event.target.value))}
              type="range"
              value={timelineZoom}
            />
          </label>
        </div>

        <div className={styles.timeline} aria-label="Multi-track timeline">
          <div className={styles.timeRuler}>
            <span>00:00</span><span>00:04</span><span>00:08</span><span>00:12</span>
            <span>00:16</span><span>00:20</span><span>{formatTime(composition.durationSec)}</span>
          </div>
          <div className={styles.trackRows}>
            <div className={styles.playhead} aria-hidden="true"><span /></div>
            <div className={styles.trackRow}>
              <div className={styles.trackLabel}><b>V1</b><span>VIDEO</span><button aria-label="Toggle video track visibility" type="button">◉</button></div>
              <div className={styles.trackLane}>
                <button className={`${styles.clip} ${styles.videoClip} ${styles.selectedClip}`} type="button">
                  <i /><span>Hero product</span><small>00:03.6</small>
                </button>
                <button className={`${styles.clip} ${styles.videoClipAlt}`} type="button">
                  <i /><span>Father + son</span><small>00:07.2</small>
                </button>
                <button className={`${styles.clip} ${styles.videoClipTeal}`} type="button">
                  <i /><span>Fabric turn</span><small>00:06.0</small>
                </button>
                {composition.clipCount > 3 && (
                  <button className={`${styles.clip} ${styles.splitClip}`} type="button">
                    <span>Split</span><small>{formatTime(playhead)}</small>
                  </button>
                )}
              </div>
            </div>
            <div className={styles.trackRow}>
              <div className={styles.trackLabel}><b>T</b><span>CAPTIONS</span><button aria-label="Toggle caption track visibility" type="button">CC</button></div>
              <div className={styles.trackLane}>
                <button className={`${styles.clip} ${styles.captionClip}`} type="button">
                  <span>{composition.caption}</span><small>Brand caption · approved style</small>
                </button>
              </div>
            </div>
            <div className={styles.trackRow}>
              <div className={styles.trackLabel}><b>V</b><span>VOICE</span><button aria-label="Mute voice track" type="button">◖</button></div>
              <div className={styles.trackLane}>
                <button className={`${styles.clip} ${styles.waveClip} ${styles.voiceClip}`} type="button">
                  <span className={styles.waveform}>▂▅▃▇▅▂▆▃▇▅▂▆▃▅▇▂▅▃▆▂▇▃▅</span>
                  <small>Owner voice · active v3</small>
                </button>
              </div>
            </div>
            <div className={styles.trackRow}>
              <div className={styles.trackLabel}><b>M</b><span>MUSIC</span><button aria-label="Mute music track" type="button">◖</button></div>
              <div className={styles.trackLane}>
                <button className={`${styles.clip} ${styles.waveClip} ${styles.musicClip}`} type="button">
                  <span className={styles.waveform}>▃▆▂▅▇▃▅▂▆▃▇▅▃▆▂▇▅▃▆▂▅▇▃</span>
                  <small>Eid pulse · {composition.musicVolume}%</small>
                </button>
              </div>
            </div>
            <div className={styles.trackRow}>
              <div className={styles.trackLabel}><b>S</b><span>SFX</span><button aria-label="Mute sound effects track" type="button">◖</button></div>
              <div className={styles.trackLane}>
                <button className={`${styles.clip} ${styles.sfxClip}`} type="button">
                  <span>Soft fabric</span><small>00:00.8</small>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <aside
        className={`${styles.workbench} ${workbenchOpen ? styles.workbenchOpen : ''}`}
        aria-label="Context workbench"
      >
        <div className={styles.workbenchTabs} role="tablist" aria-label="Inspector, Agent and Review">
          {(['inspector', 'agent', 'review'] as const).map((tab) => (
            <button
              aria-selected={workbenchTab === tab}
              className={workbenchTab === tab ? styles.activeWorkbenchTab : undefined}
              key={tab}
              onClick={() => setWorkbenchTab(tab)}
              role="tab"
              type="button"
            >
              {tab === 'agent' ? '✦ Agent' : tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
          <button
            aria-label="Close context workbench"
            className={styles.closeWorkbench}
            onClick={() => setWorkbenchOpen(false)}
            type="button"
          >
            ×
          </button>
        </div>

        {workbenchTab === 'inspector' && (
          <div className={styles.inspectorPanel}>
            <div className={styles.selectionSummary}>
              <span className={`${styles.selectionThumb} ${styles[selected.tone]}`}>A</span>
              <div><strong>{selected.name}</strong><small>{selected.meta}</small></div>
              <em>{selected.status}</em>
            </div>
            <section>
              <div className={styles.sectionTitle}><strong>Transform</strong><span>Reset</span></div>
              <div className={styles.fieldGrid}>
                <label>X <input value="0" readOnly /></label>
                <label>Y <input value="-18" readOnly /></label>
                <label>Scale <input value="104%" readOnly /></label>
                <label>Rotate <input value="0°" readOnly /></label>
              </div>
            </section>
            <section>
              <div className={styles.sectionTitle}><strong>Caption</strong><span>Recipe v7</span></div>
              <label className={styles.fullField}>
                Text
                <input
                  onChange={(event) => setComposition((current) => ({
                    ...current,
                    caption: event.target.value,
                  }))}
                  value={composition.caption}
                />
              </label>
              <div className={styles.captionWords}>
                {captionWords.map((word) => <button key={word.id} type="button"><b>{word.text}</b><small>{word.at}</small></button>)}
              </div>
            </section>
            <section>
              <div className={styles.sectionTitle}><strong>Provenance</strong><span className={styles.verified}>Verified</span></div>
              <dl className={styles.provenance}>
                <div><dt>Source</dt><dd>ERP · AL-EID-042</dd></div>
                <div><dt>Engine</dt><dd>FASHN v1.6</dd></div>
                <div><dt>Recipe</dt><dd>Editorial Warm v7</dd></div>
                <div><dt>QC</dt><dd>Identity 96 · Garment 94</dd></div>
                <div><dt>Cost</dt><dd>৳0 local edit</dd></div>
              </dl>
            </section>
          </div>
        )}

        {workbenchTab === 'agent' && (
          <div className={styles.agentPanel}>
            <div className={styles.agentIntro}>
              <div className={styles.agentAvatar}>✦</div>
              <div>
                <strong>Creative Agent</strong>
                <span>Plan first · deterministic edits</span>
              </div>
              <span className={styles.alphaBadge}>PROTOTYPE</span>
            </div>

            <div className={styles.contextStrip}>
              <span>Project</span>
              <b>Coral Panjabi Launch</b>
              <i>v{composition.version}</i>
            </div>

            {agentPhase === 'idle' && (
              <div className={styles.agentEmpty}>
                <span>✦</span>
                <h2>Edit with a reviewable plan</h2>
                <p>
                  The Agent can target the selected asset, canvas and timeline. It will not
                  generate, spend, export or publish without a separate confirmation.
                </p>
                <div className={styles.suggestionList}>
                  <button onClick={() => setInstruction('Make this a 24-second Eid reel with captions and a gentle owner voice mix. Plan only.')} type="button">
                    Plan a 24-second reel
                  </button>
                  <button onClick={() => setInstruction('Tighten the first shot and move the approved caption to the first beat.')} type="button">
                    Tighten opening + captions
                  </button>
                </div>
              </div>
            )}

            {agentPhase !== 'idle' && (
              <div className={styles.planPanel}>
                <div className={styles.planHeader}>
                  <div>
                    <span>PROPOSED PLAN</span>
                    <strong>5 operations · 3 can apply now</strong>
                  </div>
                  <span className={styles.fingerprint}>8F2C · v12</span>
                </div>
                <div className={styles.planSummary}>
                  <span className={styles.safeSummary}><b>3</b> reversible · ৳0</span>
                  <span className={styles.blockedSummary}><b>2</b> separately blocked</span>
                </div>
                <ol className={styles.operationList}>
                  {DEMO_AGENT_PLAN.map((operation) => {
                    const isApplied = agentPhase === 'applied' && operation.effect === 'local'
                    const isBlocked = operation.effect !== 'local'
                    return (
                      <li className={isBlocked ? styles.blockedOperation : undefined} key={operation.id}>
                        <span className={styles.operationIndex}>
                          {isApplied ? '✓' : isBlocked ? '!' : operation.id.slice(-2)}
                        </span>
                        <div>
                          <strong>{operation.label}</strong>
                          <small>{operation.target}</small>
                          <p><del>{operation.before}</del><span>→</span><ins>{operation.after}</ins></p>
                          <em className={isBlocked ? styles.effectBlocked : styles.effectSafe}>
                            {effectLabel(operation.effect)}
                            {operation.estimatedCostBdt > 0 ? ` · est. ৳${operation.estimatedCostBdt}` : ''}
                          </em>
                        </div>
                      </li>
                    )
                  })}
                </ol>

                {agentPhase === 'planned' && (
                  <div className={styles.planApproval}>
                    <label>
                      <input
                        checked={approved}
                        onChange={(event) => setApproved(event.target.checked)}
                        type="checkbox"
                      />
                      I reviewed fingerprint 8F2C. Apply only the 3 reversible ৳0 edits.
                    </label>
                    <button disabled={!approved} onClick={applyPlan} type="button">
                      Apply 3 safe edits
                    </button>
                    <p>AI clip generation and Meta publish require separate owner actions and remain blocked.</p>
                  </div>
                )}

                {agentPhase === 'applied' && (
                  <div className={styles.appliedState} role="status">
                    <div><span>✓</span><strong>Safe edits applied</strong><small>{auditId} · new version v{composition.version}</small></div>
                    <button onClick={undoPlan} type="button">Rollback plan</button>
                    <p>Paid generation and external publish were not executed.</p>
                  </div>
                )}

                {agentPhase === 'rolled_back' && (
                  <div className={styles.rollbackState} role="status">
                    <span>↶</span>
                    <div><strong>Rolled back safely</strong><small>New audited version v{composition.version}</small></div>
                    <button onClick={createPlan} type="button">Review plan again</button>
                  </div>
                )}
              </div>
            )}

            <div className={styles.composer}>
              <label>
                <span className={styles.srOnly}>Creative Agent instruction</span>
                <textarea onChange={(event) => setInstruction(event.target.value)} value={instruction} />
              </label>
              <div>
                <button aria-label="Add project context" type="button">＋ Context</button>
                <span>Mode: <b>Plan</b></span>
                <button className={styles.planButton} onClick={createPlan} type="button">
                  {agentPhase === 'idle' ? 'Create plan' : 'Re-plan'}
                </button>
              </div>
            </div>
          </div>
        )}

        {workbenchTab === 'review' && (
          <div className={styles.reviewPanel}>
            <div className={styles.reviewStatus}>
              <span>VERSION REVIEW</span>
              <strong>Changes requested</strong>
              <p>Approval is pinned to v11. Current v{composition.version} requires review.</p>
            </div>
            <div className={styles.reviewer}>
              <span>MB</span>
              <div><strong>Owner</strong><small>Project owner · full capability</small></div>
            </div>
            <article>
              <header><b>Reviewer</b><time>12 min ago</time></header>
              <p>Bring the first caption forward, but keep the product code visible through the opening beat.</p>
              <span>00:01.2 · Caption track</span>
            </article>
            <article>
              <header><b>Creative Agent</b><time>Plan 8F2C</time></header>
              <p>Proposed a local timing change. No paid or external action is included in the applicable batch.</p>
              <span>Audit preview</span>
            </article>
            <button className={styles.reviewButton} type="button">Request owner review</button>
            <p className={styles.prototypeNote}>Prototype only—no review event will be written.</p>
          </div>
        )}
      </aside>

      <div className={styles.notice} role="status">
        <span>●</span>
        <p>{notice}</p>
        <button aria-label="Dismiss status message" onClick={() => setNotice('')} type="button">×</button>
      </div>
    </main>
  )
}
