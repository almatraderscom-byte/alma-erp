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
import {
  ASSET_FIXTURES,
  CAPTION_WORDS,
  TOOL_COPY,
  toolForCreateKind,
  type CreateKind,
  type EditorTool,
  type StudioProject,
} from './studio-v2-fixtures'
import { agentPlanMatchesVersion } from './studio-v3-fixtures'
import { StudioV2Icon, type StudioIconName } from './StudioV2Icon'
import styles from './CreativeStudioEnterpriseDemo.module.css'

type WorkbenchTab = 'inspector' | 'agent' | 'review'
type AgentPhase = 'idle' | 'planned' | 'applied' | 'rolled_back'
type TimelineSelection = 'video-hero' | 'caption' | 'voice' | 'music' | 'sfx'

type CreativeStudioEditorProps = {
  entryKind: CreateKind
  entryProject?: StudioProject
  initiallyOpenAgent?: boolean
  onHome: () => void
}

const editorTools: ReadonlyArray<{
  id: EditorTool
  label: string
  icon: StudioIconName
}> = [
  { id: 'image', label: 'Images', icon: 'image' },
  { id: 'video', label: 'Video', icon: 'video' },
  { id: 'voice', label: 'Voice', icon: 'voice' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'library', label: 'Library', icon: 'library' },
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
  if (effect === 'external_publish') return 'External publish'
  return 'Reversible local edit'
}

function Waveform({ variant }: { variant: 'voice' | 'music' }) {
  const bars = variant === 'voice'
    ? [22, 48, 32, 72, 56, 28, 62, 38, 76, 45, 30, 68, 42, 58, 74, 24, 52, 36, 66, 29, 78, 38, 54, 32, 60, 44, 70, 28]
    : [34, 58, 26, 52, 70, 40, 62, 28, 56, 38, 72, 48, 34, 60, 29, 68, 50, 36, 64, 28, 54, 74, 42, 30, 58, 48, 66, 35]
  return (
    <span aria-hidden="true" className={styles.waveform}>
      {bars.map((height, index) => (
        <i key={`${variant}-${index}`} style={{ height: `${height}%` }} />
      ))}
    </span>
  )
}

function CampaignFrame({
  caption,
  safeZone,
}: {
  caption: string
  safeZone: boolean
}) {
  return (
    <div className={styles.campaignFrame}>
      <div className={styles.frameMasthead}>
        <strong>ALMA</strong>
        <span>EID / 26</span>
      </div>
      <div className={styles.frameHalo} />
      <div className={styles.frameFigure} aria-label="Stylized coral Panjabi campaign preview">
        <span className={styles.figureHead} />
        <span className={styles.figureNeck} />
        <div className={styles.figureGarment}>
          <i className={styles.garmentPlacket} />
          <i className={styles.garmentPocket} />
          <i className={styles.garmentCuff} />
        </div>
      </div>
      <div className={styles.frameEditorial}>
        <span>NEW SEASON</span>
        <strong>Quiet confidence,<br />made for Eid.</strong>
        <small>AL-EID-042 · Coral cotton panjabi</small>
      </div>
      <div className={styles.frameCaption}>{caption}</div>
      <span className={styles.frameNumber}>01 / 03</span>
      {safeZone && <span className={styles.frameSafeZone} aria-hidden="true" />}
      <span className={styles.framePrototype}>CONCEPT PREVIEW</span>
    </div>
  )
}

function TimelineTrack({
  active,
  children,
  icon,
  label,
  onSelect,
  shortcut,
}: {
  active: boolean
  children: React.ReactNode
  icon: StudioIconName
  label: string
  onSelect: () => void
  shortcut: string
}) {
  return (
    <div className={`${styles.timelineTrack} ${active ? styles.timelineTrackActive : ''}`}>
      <button
        aria-pressed={active}
        className={styles.trackIdentity}
        onClick={onSelect}
        type="button"
      >
        <span>
          <StudioV2Icon name={icon} size={15} />
        </span>
        <strong>{label}</strong>
        <kbd>{shortcut}</kbd>
      </button>
      <div className={styles.trackLane}>{children}</div>
    </div>
  )
}

export function CreativeStudioEditor({
  entryKind,
  entryProject,
  initiallyOpenAgent = false,
  onHome,
}: CreativeStudioEditorProps) {
  const [activeTool, setActiveTool] = useState<EditorTool>(toolForCreateKind(entryKind))
  const [selectedAsset, setSelectedAsset] = useState('hero')
  const [timelineSelection, setTimelineSelection] =
    useState<TimelineSelection>('video-hero')
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>(
    initiallyOpenAgent ? 'agent' : 'inspector',
  )
  const [contextOpen, setContextOpen] = useState(true)
  const [assetPanelOpen, setAssetPanelOpen] = useState(true)
  const [mobilePanel, setMobilePanel] = useState<'none' | 'assets' | 'context'>(
    initiallyOpenAgent ? 'context' : 'none',
  )
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(
    initiallyOpenAgent ? 'planned' : 'idle',
  )
  const [instruction, setInstruction] = useState(
    'Opening shotটা tighter করো, caption beat-এ আনো, voice-এর নিচে music কমাও। Paid বা publish কিছু কোরো না।',
  )
  const [approved, setApproved] = useState(false)
  const [composition, setComposition] =
    useState<DemoCompositionState>(INITIAL_DEMO_STATE)
  const [planBaseVersion, setPlanBaseVersion] = useState(
    INITIAL_DEMO_STATE.version,
  )
  const [captionDraft, setCaptionDraft] = useState(INITIAL_DEMO_STATE.caption)
  const [rollbackPoint, setRollbackPoint] =
    useState<DemoCompositionState | null>(null)
  const [auditId, setAuditId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(5.8)
  const [playing, setPlaying] = useState(false)
  const [timelineZoom, setTimelineZoom] = useState(72)
  const [notice, setNotice] = useState(
    'Prototype workspace · fixtures only · no provider, export or publish connection',
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

  const selected = ASSET_FIXTURES.find((asset) => asset.id === selectedAsset)
    ?? ASSET_FIXTURES[0]
  const filteredAssets = activeTool === 'library'
    ? ASSET_FIXTURES
    : activeTool === 'audio'
      ? ASSET_FIXTURES.filter((asset) => asset.type === 'music' || asset.type === 'sfx')
      : activeTool === 'voice'
        ? ASSET_FIXTURES.filter((asset) => asset.type === 'voice')
        : ASSET_FIXTURES.filter((asset) => (
          asset.type === activeTool || (activeTool === 'video' && asset.type === 'image')
        ))
  const playheadPercent = Math.min(100, (playhead / composition.durationSec) * 100)
  const planCurrent = agentPlanMatchesVersion(planBaseVersion, composition.version)
  const editorStyle = {
    '--playhead-position': `${playheadPercent}%`,
    '--timeline-scale': `${timelineZoom / 72}`,
  } as CSSProperties
  const projectTitle = entryProject?.title ?? (
    entryKind === 'image'
      ? 'Untitled Image Workspace'
      : entryKind === 'campaign'
        ? 'Untitled Campaign Pack'
        : entryKind === 'longform'
          ? 'Untitled Long-form Story'
          : entryKind === 'voice'
            ? 'Untitled Voice Workspace'
            : entryKind === 'audio'
              ? 'Untitled Audio Mix'
              : 'Coral Panjabi Launch'
  )

  function showContext(tab: WorkbenchTab) {
    setWorkbenchTab(tab)
    setContextOpen(true)
    setMobilePanel('context')
  }

  function selectTimeline(target: TimelineSelection, tab: WorkbenchTab = 'inspector') {
    setTimelineSelection(target)
    showContext(tab)
  }

  function createPlan() {
    showContext('agent')
    setPlanBaseVersion(composition.version)
    setAgentPhase('planned')
    setApproved(false)
    setNotice(
      `Plan fingerprint 8F2C created against composition v${composition.version}. Exact owner review is required.`,
    )
  }

  function applyPlan() {
    if (!planCurrent) {
      setApproved(false)
      setNotice(
        `Composition advanced to v${composition.version}. Re-plan before applying any operation.`,
      )
      return
    }
    if (!approved) {
      setNotice('Review and acknowledge this exact plan fingerprint before applying.')
      return
    }
    const result = applyDemoPlan(composition, DEMO_PLAN_FINGERPRINT)
    setRollbackPoint(composition)
    setComposition(result.state)
    setAuditId(result.auditId)
    setAgentPhase('applied')
    setPlayhead(Math.min(playhead, result.state.durationSec))
    setNotice('3 reversible ৳0 edits applied. Paid generation and publish remain blocked.')
  }

  function rollbackPlan() {
    if (!rollbackPoint) return
    setComposition((current) => rollbackDemoPlan(current, rollbackPoint))
    setCaptionDraft(rollbackPoint.caption)
    setAgentPhase('rolled_back')
    setApproved(false)
    setNotice('Rollback recorded as a new audited version. No provider call was made.')
  }

  function commitCaption() {
    setComposition((current) => ({
      ...current,
      caption: captionDraft,
      version: current.version + 1,
    }))
    setNotice('Caption updated as a reversible local edit.')
  }

  function restoreCaption() {
    setCaptionDraft(INITIAL_DEMO_STATE.caption)
    setComposition((current) => ({
      ...current,
      caption: INITIAL_DEMO_STATE.caption,
      version: current.version + 1,
    }))
    setNotice('Caption restored to recipe v7 as a new audited version.')
  }

  function splitAtPlayhead() {
    setComposition((current) => ({
      ...current,
      version: current.version + 1,
      clipCount: current.clipCount + 1,
    }))
    setNotice(`Clip split at ${formatTime(playhead)} · local prototype operation`)
  }

  function disconnected(action: string) {
    setNotice(`${action} is intentionally disconnected. Nothing was generated, sent or published.`)
  }

  return (
    <section
      aria-label={`ALMA Creative Studio editor for ${projectTitle}`}
      className={styles.editorShell}
      style={editorStyle}
    >
      <a className={styles.skipLink} href="#studio-canvas">
        Skip to canvas
      </a>

      <header className={styles.editorTopbar}>
        <div className={styles.editorProjectIdentity}>
          <button aria-label="Return to Creative Studio Home" onClick={onHome} type="button">
            <StudioV2Icon name="arrow-left" size={20} />
          </button>
          <span className={styles.editorAlmaMark}>A</span>
          <div>
            <span>ALMA Lifestyle / Eid 2026</span>
            <strong>{projectTitle}</strong>
          </div>
          <button aria-label="Open project menu" className={styles.projectMenuButton} type="button">
            <StudioV2Icon name="chevron-down" size={16} />
          </button>
        </div>

        <div className={styles.editorLifecycle}>
          <span className={styles.savedStatus}>
            <StudioV2Icon name="check" size={14} />
            Saved
          </span>
          <span className={styles.versionStatus}>v{composition.version}</span>
          <button
            aria-label="Rollback latest applied Agent plan"
            disabled={!rollbackPoint || agentPhase === 'rolled_back'}
            onClick={rollbackPlan}
            type="button"
          >
            <StudioV2Icon name="undo" size={18} />
          </button>
          <button aria-label="Redo unavailable in prototype" disabled type="button">
            <StudioV2Icon name="redo" size={18} />
          </button>
          <button onClick={() => showContext('review')} type="button">
            <StudioV2Icon name="review" size={17} />
            Review
            <span>3</span>
          </button>
        </div>

        <div className={styles.editorActions}>
          <button
            aria-pressed={contextOpen}
            className={contextOpen ? styles.editorActionActive : undefined}
            onClick={() => setContextOpen((current) => !current)}
            type="button"
          >
            <StudioV2Icon name="inspector" size={18} />
            Context
          </button>
          <button onClick={() => disconnected('Share')} type="button">
            <StudioV2Icon name="share" size={17} />
            Share
          </button>
          <button className={styles.exportButtonV2} onClick={() => disconnected('Export')} type="button">
            <StudioV2Icon name="download" size={17} />
            Export
          </button>
        </div>
      </header>

      <div className={styles.editorTrustbar}>
        <span>
          <StudioV2Icon name="lock" size={14} />
          Owner workspace · brand isolated
        </span>
        <span>1080 × 1920 verified</span>
        <span>Upscale prohibited</span>
        <span className={styles.editorPrototypeFlag}>PROTOTYPE · PROVIDERS OFF</span>
      </div>

      <div
        className={`${styles.editorWorkspace} ${!assetPanelOpen ? styles.editorWorkspaceAssetsClosed : ''} ${!contextOpen ? styles.editorWorkspaceContextClosed : ''}`}
      >
        <aside className={styles.editorDock} aria-label="Editor media tools">
          <button
            aria-label={assetPanelOpen ? 'Hide asset panel' : 'Show asset panel'}
            className={styles.addMediaButton}
            onClick={() => setAssetPanelOpen((current) => !current)}
            type="button"
          >
            <StudioV2Icon name={assetPanelOpen ? 'close' : 'plus'} size={20} />
          </button>
          <nav>
            {editorTools.map((tool) => (
              <button
                aria-pressed={activeTool === tool.id}
                className={activeTool === tool.id ? styles.editorToolActive : undefined}
                key={tool.id}
                onClick={() => {
                  setActiveTool(tool.id)
                  setAssetPanelOpen(true)
                }}
                type="button"
              >
                <span>
                  <StudioV2Icon name={tool.icon} size={20} />
                </span>
                {tool.label}
              </button>
            ))}
          </nav>
          <button
            className={`${styles.dockAgentButton} ${workbenchTab === 'agent' ? styles.editorToolActive : ''}`}
            onClick={() => showContext('agent')}
            type="button"
          >
            <span>
              <StudioV2Icon name="agent" size={20} />
            </span>
            Agent
          </button>
        </aside>

        <aside
          className={`${styles.editorAssetPanel} ${mobilePanel === 'assets' ? styles.mobileSheetVisible : ''}`}
          aria-label={`${TOOL_COPY[activeTool].title} browser`}
        >
          <header className={styles.assetPanelHeader}>
            <span>{TOOL_COPY[activeTool].eyebrow}</span>
            <h1>{TOOL_COPY[activeTool].title}</h1>
            <p>{TOOL_COPY[activeTool].hint}</p>
          </header>

          <div className={styles.assetScope} role="tablist" aria-label="Asset source">
            <button aria-selected="true" className={styles.assetScopeActive} role="tab" type="button">
              Project
            </button>
            <button aria-selected="false" role="tab" type="button">
              Workspace
            </button>
            <button aria-selected="false" role="tab" type="button">
              Catalog
            </button>
          </div>

          <label className={styles.assetSearch}>
            <StudioV2Icon name="search" size={16} />
            <span className={styles.srOnly}>Search current assets</span>
            <input placeholder="Search current assets" />
          </label>

          {activeTool !== 'library' && (
            <button
              className={styles.addAssetCard}
              onClick={() => disconnected('Provider generation')}
              type="button"
            >
              <span>
                <StudioV2Icon name="plus" size={18} />
              </span>
              <span>
                <strong>
                  {activeTool === 'video'
                    ? 'Add video'
                    : activeTool === 'audio'
                      ? 'Add approved sound'
                      : `Add ${TOOL_COPY[activeTool].title.toLowerCase()}`}
                </strong>
                <small>Upload or configure a provider after review</small>
              </span>
            </button>
          )}

          <div className={styles.assetListHeading}>
            <strong>{activeTool === 'library' ? 'Reusable library' : 'In this project'}</strong>
            <span>{filteredAssets.length} items</span>
          </div>

          <div className={styles.assetList}>
            {filteredAssets.map((asset) => (
              <button
                aria-pressed={selectedAsset === asset.id}
                className={selectedAsset === asset.id ? styles.assetItemActive : undefined}
                key={asset.id}
                onClick={() => {
                  setSelectedAsset(asset.id)
                  showContext('inspector')
                }}
                type="button"
              >
                <span className={`${styles.assetVisual} ${styles[`assetVisual_${asset.tone}`]}`}>
                  <StudioV2Icon
                    name={
                      asset.type === 'video'
                        ? 'video'
                        : asset.type === 'voice'
                          ? 'voice'
                          : asset.type === 'music' || asset.type === 'sfx'
                            ? 'audio'
                            : 'image'
                    }
                    size={18}
                  />
                </span>
                <span className={styles.assetItemCopy}>
                  <strong>{asset.name}</strong>
                  <small>{asset.meta}</small>
                  <em>{asset.status}</em>
                </span>
                <StudioV2Icon name="more" size={17} />
              </button>
            ))}
          </div>

          <div className={styles.projectContextCards}>
            <span>PROJECT CONTEXT</span>
            <button type="button">
              <StudioV2Icon name="folder" size={16} />
              <span>
                <small>Folder</small>
                <strong>Eid / Coral launch</strong>
              </span>
            </button>
            <button type="button">
              <StudioV2Icon name="template" size={16} />
              <span>
                <small>Recipe</small>
                <strong>Editorial Warm · v7</strong>
              </span>
              <StudioV2Icon name="lock" size={13} />
            </button>
          </div>
        </aside>

        <section className={styles.editDesk}>
          <div className={styles.stageCard}>
            <div className={styles.stageCardHeader}>
              <div>
                <span className={styles.stageFormat}>9:16</span>
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
                <button type="button">Fit</button>
              </div>
              <div>
                <span>Preview · 1080 × 1920</span>
                <span className={styles.qcState}>
                  <StudioV2Icon name="check" size={13} />
                  QC passed
                </span>
              </div>
            </div>

            <div className={styles.stageTheatre} id="studio-canvas">
              <CampaignFrame caption={composition.caption} safeZone={composition.safeZone} />
            </div>

            <div className={styles.transportBar}>
              <div>
                <button aria-label="Go to start" onClick={() => setPlayhead(0)} type="button">
                  <StudioV2Icon name="skip-back" size={17} />
                </button>
                <button
                  aria-label={playing ? 'Pause preview' : 'Play preview'}
                  className={styles.transportPlay}
                  onClick={() => setPlaying((current) => !current)}
                  type="button"
                >
                  <StudioV2Icon name={playing ? 'pause' : 'play'} size={18} />
                </button>
                <span className={styles.transportTime}>
                  <strong>{formatTime(playhead)}</strong>
                  <small>/ {formatTime(composition.durationSec)}</small>
                </span>
              </div>
              <div className={styles.transportTools}>
                <button onClick={splitAtPlayhead} type="button">
                  <StudioV2Icon name="scissors" size={16} />
                  Split
                </button>
                <label>
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
            </div>
          </div>

          <section className={styles.timelineCard} aria-label="Multi-track project timeline">
            <header className={styles.timelineHeader}>
              <div>
                <h2>Timeline</h2>
                <span>{composition.clipCount + 4} clips · 5 tracks</span>
              </div>
              <div>
                <button type="button">Snapping on</button>
                <button aria-label="Timeline options" type="button">
                  <StudioV2Icon name="more" size={18} />
                </button>
              </div>
            </header>

            <div className={styles.timelineViewport}>
              <div className={styles.timelineRuler}>
                <span />
                <div>
                  {['00:00', '00:04', '00:08', '00:12', '00:16', '00:20', '00:24'].map((time) => (
                    <time key={time}>{time}</time>
                  ))}
                </div>
              </div>
              <div className={styles.timelineTracks}>
                <div className={styles.timelinePlayhead} aria-hidden="true">
                  <span />
                </div>
                <TimelineTrack
                  active={timelineSelection === 'video-hero'}
                  icon="video"
                  label="Video"
                  onSelect={() => selectTimeline('video-hero')}
                  shortcut="V1"
                >
                  <button
                    className={`${styles.timelineClip} ${styles.videoClipPrimary}`}
                    onClick={() => selectTimeline('video-hero')}
                    type="button"
                  >
                    <span />
                    <strong>Hero product</strong>
                    <small>3.6s</small>
                  </button>
                  <button className={`${styles.timelineClip} ${styles.videoClipSand}`} type="button">
                    <span />
                    <strong>Father + son</strong>
                    <small>7.2s</small>
                  </button>
                  <button className={`${styles.timelineClip} ${styles.videoClipSage}`} type="button">
                    <span />
                    <strong>Fabric turn</strong>
                    <small>6.0s</small>
                  </button>
                  {composition.clipCount > 3 && (
                    <button className={`${styles.timelineClip} ${styles.videoClipSplit}`} type="button">
                      <strong>Split</strong>
                      <small>{formatTime(playhead)}</small>
                    </button>
                  )}
                </TimelineTrack>

                <TimelineTrack
                  active={timelineSelection === 'caption'}
                  icon="caption"
                  label="Captions"
                  onSelect={() => selectTimeline('caption')}
                  shortcut="CC"
                >
                  <button
                    className={`${styles.timelineClip} ${styles.captionTimelineClip}`}
                    onClick={() => selectTimeline('caption')}
                    type="button"
                  >
                    <strong>{composition.caption}</strong>
                    <small>Recipe v7 · approved style</small>
                  </button>
                </TimelineTrack>

                <TimelineTrack
                  active={timelineSelection === 'voice'}
                  icon="voice"
                  label="Voice"
                  onSelect={() => selectTimeline('voice')}
                  shortcut="VO"
                >
                  <button
                    className={`${styles.timelineClip} ${styles.voiceTimelineClip}`}
                    onClick={() => selectTimeline('voice')}
                    type="button"
                  >
                    <Waveform variant="voice" />
                    <small>Owner voice · active v3</small>
                  </button>
                </TimelineTrack>

                <TimelineTrack
                  active={timelineSelection === 'music'}
                  icon="audio"
                  label="Music"
                  onSelect={() => selectTimeline('music')}
                  shortcut="M"
                >
                  <button
                    className={`${styles.timelineClip} ${styles.musicTimelineClip}`}
                    onClick={() => selectTimeline('music')}
                    type="button"
                  >
                    <Waveform variant="music" />
                    <small>Eid pulse · {composition.musicVolume}%</small>
                  </button>
                </TimelineTrack>

                <TimelineTrack
                  active={timelineSelection === 'sfx'}
                  icon="audio"
                  label="SFX"
                  onSelect={() => selectTimeline('sfx')}
                  shortcut="FX"
                >
                  <button
                    className={`${styles.timelineClip} ${styles.sfxTimelineClip}`}
                    onClick={() => selectTimeline('sfx')}
                    type="button"
                  >
                    <strong>Soft fabric</strong>
                    <small>00:00.8</small>
                  </button>
                </TimelineTrack>
              </div>
            </div>
          </section>
        </section>

        <aside
          aria-label="Editor context panel"
          className={`${styles.contextPanel} ${contextOpen ? styles.contextPanelOpen : ''} ${mobilePanel === 'context' ? styles.mobileSheetVisible : ''}`}
        >
          <div className={styles.contextTabs} role="tablist" aria-label="Inspector, Agent and Review">
            {([
              ['inspector', 'inspector', 'Inspector'],
              ['agent', 'agent', 'Agent'],
              ['review', 'review', 'Review'],
            ] as const).map(([tab, icon, label]) => (
              <button
                aria-selected={workbenchTab === tab}
                className={workbenchTab === tab ? styles.contextTabActive : undefined}
                key={tab}
                onClick={() => setWorkbenchTab(tab)}
                role="tab"
                type="button"
              >
                <StudioV2Icon name={icon} size={17} />
                {label}
              </button>
            ))}
            <button
              aria-label="Close context panel"
              className={styles.contextClose}
              onClick={() => setContextOpen(false)}
              type="button"
            >
              <StudioV2Icon name="close" size={17} />
            </button>
          </div>

          {workbenchTab === 'inspector' && (
            <div className={styles.inspectorPanelV2}>
              <header className={styles.inspectorSelection}>
                <span className={`${styles.inspectorThumb} ${styles[`assetVisual_${selected.tone}`]}`}>
                  <StudioV2Icon name={selected.type === 'video' ? 'video' : 'image'} size={19} />
                </span>
                <div>
                  <span>SELECTED ASSET</span>
                  <strong>{selected.name}</strong>
                  <small>{selected.meta}</small>
                </div>
                <button aria-label="Selection options" type="button">
                  <StudioV2Icon name="more" size={18} />
                </button>
              </header>

              <section className={styles.inspectorSection}>
                <header>
                  <strong>Transform</strong>
                  <button type="button">Reset</button>
                </header>
                <div className={styles.inspectorFields}>
                  <label>
                    <span>X</span>
                    <input readOnly value="0" />
                  </label>
                  <label>
                    <span>Y</span>
                    <input readOnly value="-18" />
                  </label>
                  <label>
                    <span>Scale</span>
                    <input readOnly value="104%" />
                  </label>
                  <label>
                    <span>Rotate</span>
                    <input readOnly value="0°" />
                  </label>
                </div>
              </section>

              <section className={styles.inspectorSection}>
                <header>
                  <strong>Caption</strong>
                  <span>Recipe v7</span>
                </header>
                <label className={styles.captionField}>
                  <span>Text</span>
                  <textarea
                    onChange={(event) => setCaptionDraft(event.target.value)}
                    value={captionDraft}
                  />
                </label>
                <div className={styles.wordTiming}>
                  {CAPTION_WORDS.map((word) => (
                    <button key={word.id} onClick={() => setPlayhead(Number(word.at.slice(3)))} type="button">
                      <strong>{word.text}</strong>
                      <small>{word.at}</small>
                    </button>
                  ))}
                </div>
                <div className={styles.captionActions}>
                  <button className={styles.tertiaryButton} onClick={restoreCaption} type="button">
                    Restore recipe
                  </button>
                  <button
                    className={styles.primaryButton}
                    disabled={captionDraft === composition.caption || !captionDraft.trim()}
                    onClick={commitCaption}
                    type="button"
                  >
                    Save caption
                  </button>
                </div>
              </section>

              <section className={styles.inspectorSection}>
                <header>
                  <strong>Provenance & policy</strong>
                  <span className={styles.verifiedState}>
                    <StudioV2Icon name="check" size={12} />
                    Verified
                  </span>
                </header>
                <dl className={styles.provenanceGrid}>
                  <div><dt>Source</dt><dd>{selected.provenance}</dd></div>
                  <div><dt>Engine</dt><dd>FASHN v1.6 commercial</dd></div>
                  <div><dt>Recipe</dt><dd>Editorial Warm v7</dd></div>
                  <div><dt>QC</dt><dd>Identity 96 · Garment 94</dd></div>
                  <div><dt>Resolution</dt><dd>1080 × 1920 verified</dd></div>
                  <div><dt>Edit cost</dt><dd>৳0 local</dd></div>
                </dl>
              </section>
            </div>
          )}

          {workbenchTab === 'agent' && (
            <div className={styles.agentPanelV2}>
              <header className={styles.agentHeaderV2}>
                <span className={styles.agentMark}>
                  <StudioV2Icon name="agent" size={21} />
                </span>
                <div>
                  <span>CREATIVE AGENT</span>
                  <strong>Plan before change</strong>
                  <small>Deterministic operations · audit on apply</small>
                </div>
                <span className={styles.agentPrototypeBadge}>V3 DEMO</span>
              </header>

              <div className={styles.agentProjectContext}>
                <span>
                  <small>PROJECT</small>
                  <strong>{projectTitle}</strong>
                </span>
                <em>v{composition.version}</em>
              </div>

              {agentPhase === 'idle' && (
                <div className={styles.agentIdleV2}>
                  <span>
                    <StudioV2Icon name="agent" size={25} />
                  </span>
                  <h2>Describe an edit, receive a reviewable plan.</h2>
                  <p>
                    Agent can address the stage, selected asset and timeline. Generation,
                    spend and external delivery are separate capabilities.
                  </p>
                  <div>
                    <button
                      onClick={() => setInstruction('Make this a 24-second Eid reel with captions and a gentle owner voice mix. Plan only.')}
                      type="button"
                    >
                      Plan a 24-second reel
                    </button>
                    <button
                      onClick={() => setInstruction('Tighten the opening and move the approved caption to the first beat.')}
                      type="button"
                    >
                      Tighten opening + captions
                    </button>
                  </div>
                </div>
              )}

              {agentPhase !== 'idle' && (
                <div className={styles.agentPlanV2}>
                  <header className={styles.planTitleV2}>
                    <div>
                      <span>PROPOSED CHANGESET</span>
                      <strong>Opening rhythm + voice mix</strong>
                    </div>
                    <span>
                      <StudioV2Icon name="lock" size={13} />
                      8F2C · base v{planBaseVersion}
                    </span>
                  </header>

                  <div className={styles.planImpactSummary}>
                    <span>
                      <strong>3</strong>
                      reversible edits
                      <em>৳0</em>
                    </span>
                    <span>
                      <strong>2</strong>
                      gated capabilities
                      <em>blocked</em>
                    </span>
                  </div>

                  <section className={styles.operationGroup}>
                    <header>
                      <span>
                        <StudioV2Icon name="check" size={14} />
                        CAN APPLY AFTER REVIEW
                      </span>
                      <em>3 operations</em>
                    </header>
                    <ol>
                      {DEMO_AGENT_PLAN.filter((operation) => operation.effect === 'local').map((operation) => (
                        <li key={operation.id}>
                          <span className={styles.operationStatus}>
                            {agentPhase === 'applied'
                              ? <StudioV2Icon name="check" size={14} />
                              : operation.id.slice(-2)}
                          </span>
                          <div>
                            <strong>{operation.label}</strong>
                            <small>{operation.target}</small>
                            <p><del>{operation.before}</del><span>→</span><ins>{operation.after}</ins></p>
                          </div>
                          <em>৳0</em>
                        </li>
                      ))}
                    </ol>
                  </section>

                  <section className={`${styles.operationGroup} ${styles.blockedOperationGroup}`}>
                    <header>
                      <span>
                        <StudioV2Icon name="lock" size={14} />
                        SEPARATE OWNER GATES
                      </span>
                      <em>Not in this apply</em>
                    </header>
                    <ol>
                      {DEMO_AGENT_PLAN.filter((operation) => operation.effect !== 'local').map((operation) => (
                        <li key={operation.id}>
                          <span className={styles.operationStatus}>
                            <StudioV2Icon name="lock" size={13} />
                          </span>
                          <div>
                            <strong>{operation.label}</strong>
                            <small>{effectLabel(operation.effect)} · {operation.target}</small>
                          </div>
                          <em>
                            {operation.estimatedCostBdt > 0
                              ? `est. ৳${operation.estimatedCostBdt}`
                              : 'external'}
                          </em>
                        </li>
                      ))}
                    </ol>
                  </section>

                  {agentPhase === 'planned' && (
                    <div className={styles.planApprovalV2}>
                      <label>
                        <input
                          checked={approved}
                          disabled={!planCurrent}
                          onChange={(event) => setApproved(event.target.checked)}
                          type="checkbox"
                        />
                        <span>
                          <strong>
                            I reviewed fingerprint 8F2C for base v{planBaseVersion}.
                          </strong>
                          <small>Apply only the three reversible ৳0 operations.</small>
                        </span>
                      </label>
                      <button
                        className={styles.primaryButton}
                        disabled={!approved || !planCurrent}
                        onClick={applyPlan}
                        type="button"
                      >
                        Apply 3 safe edits
                        <StudioV2Icon name="chevron-right" size={17} />
                      </button>
                      {!planCurrent && (
                        <p role="alert">
                          Project is now v{composition.version}. Re-plan to create a current fingerprint review.
                        </p>
                      )}
                      <p>AI video generation and external publish stay locked.</p>
                    </div>
                  )}

                  {agentPhase === 'applied' && (
                    <div className={styles.agentAppliedV2} role="status">
                      <span>
                        <StudioV2Icon name="check" size={18} />
                      </span>
                      <div>
                        <strong>Safe edits applied</strong>
                        <small>{auditId} · composition v{composition.version}</small>
                        <p>Paid generation and publish were not executed.</p>
                      </div>
                      <button onClick={rollbackPlan} type="button">
                        <StudioV2Icon name="undo" size={16} />
                        Roll back
                      </button>
                    </div>
                  )}

                  {agentPhase === 'rolled_back' && (
                    <div className={styles.agentRollbackV2} role="status">
                      <span>
                        <StudioV2Icon name="undo" size={18} />
                      </span>
                      <div>
                        <strong>Rolled back safely</strong>
                        <small>New audited version v{composition.version}</small>
                      </div>
                      <button onClick={createPlan} type="button">Review again</button>
                    </div>
                  )}
                </div>
              )}

              <div className={styles.agentComposerV2}>
                <label>
                  <span className={styles.srOnly}>Creative Agent instruction</span>
                  <textarea
                    onChange={(event) => setInstruction(event.target.value)}
                    value={instruction}
                  />
                </label>
                <div>
                  <span>
                    <StudioV2Icon name="lock" size={13} />
                    Mode: <strong>Plan</strong>
                  </span>
                  <button className={styles.agentPlanButton} onClick={createPlan} type="button">
                    {agentPhase === 'idle' ? 'Build plan' : 'Re-plan'}
                    <StudioV2Icon name="agent" size={16} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {workbenchTab === 'review' && (
            <div className={styles.reviewPanelV2}>
              <header>
                <span>VERSION REVIEW</span>
                <h2>Changes requested</h2>
                <p>Approval is pinned to v11. Current v{composition.version} requires review.</p>
              </header>
              <div className={styles.reviewOwner}>
                <span>MB</span>
                <div>
                  <strong>Owner review</strong>
                  <small>Full project capability · final approval</small>
                </div>
                <em>OPEN</em>
              </div>
              <article>
                <header><strong>Reviewer</strong><time>12 min ago</time></header>
                <p>
                  Bring the first caption forward, but keep the product code visible through
                  the opening beat.
                </p>
                <span>
                  <StudioV2Icon name="caption" size={14} />
                  00:01.2 · Caption track
                </span>
              </article>
              <article>
                <header><strong>Creative Agent</strong><time>Plan 8F2C</time></header>
                <p>
                  A reversible timing change is ready. Paid and external operations are excluded.
                </p>
                <span>
                  <StudioV2Icon name="lock" size={14} />
                  Audit preview
                </span>
              </article>
              <div className={styles.reviewActions}>
                <button className={styles.secondaryButton} onClick={() => disconnected('Review request')} type="button">
                  Request owner review
                </button>
                <p>Prototype only—no review event will be written.</p>
              </div>
            </div>
          )}
        </aside>
      </div>

      <nav className={styles.editorMobileNav} aria-label="Mobile editor panels">
        <button onClick={onHome} type="button">
          <StudioV2Icon name="home" size={19} />
          Home
        </button>
        <button
          className={mobilePanel === 'assets' ? styles.mobileNavActive : undefined}
          onClick={() => {
            setAssetPanelOpen(true)
            setMobilePanel((current) => current === 'assets' ? 'none' : 'assets')
          }}
          type="button"
        >
          <StudioV2Icon name="assets" size={19} />
          Media
        </button>
        <button
          className={mobilePanel === 'context' && workbenchTab === 'inspector' ? styles.mobileNavActive : undefined}
          onClick={() => showContext('inspector')}
          type="button"
        >
          <StudioV2Icon name="inspector" size={19} />
          Inspector
        </button>
        <button
          className={mobilePanel === 'context' && workbenchTab === 'agent' ? styles.mobileNavActive : undefined}
          onClick={() => showContext('agent')}
          type="button"
        >
          <StudioV2Icon name="agent" size={19} />
          Agent
        </button>
      </nav>

      <div className={styles.editorNotice} role="status">
        <span className={styles.editorNoticeDot} />
        <p>{notice}</p>
        <button aria-label="Dismiss status" onClick={() => setNotice('')} type="button">
          <StudioV2Icon name="close" size={15} />
        </button>
      </div>
    </section>
  )
}
