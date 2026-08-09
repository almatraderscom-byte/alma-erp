'use client'

import type { CSSProperties, RefObject } from 'react'
import type {
  EditorClip,
  EditorCompositionSnapshot,
  EditorTrack,
} from '@/lib/creative-studio/editor-agent'
import { EditorIcon, type EditorIconName } from './EditorIcon'
import { formatEditorTime, statusLabel } from './editor-utils'
import type { EditorSelection } from './ui-types'
import styles from './ProjectEditor.module.css'

function trackIcon(kind: EditorTrack['kind']): EditorIconName {
  if (kind === 'caption') return 'caption'
  if (kind === 'voice') return 'voice'
  if (kind === 'music') return 'music'
  if (kind === 'sfx') return 'sfx'
  if (kind === 'overlay') return 'layers'
  return 'video'
}

function Waveform({ clip }: { clip: EditorClip }) {
  const bars = [28, 52, 74, 38, 62, 46, 82, 30, 58, 70, 42, 78, 34, 64, 50, 72, 38, 84, 44, 60, 32, 68]
  return (
    <span className={styles.timelineWaveform} aria-hidden="true">
      {bars.map((height, index) => (
        <i
          key={`${clip.id}-wave-${index}`}
          style={{ height: `${Math.max(12, height * clip.volume)}%` }}
        />
      ))}
    </span>
  )
}

export function EditorTimeline({
  onMoveClip,
  onSelect,
  onSplit,
  onZoomChange,
  readOnly,
  regionRef,
  selection,
  snapshot,
  playheadSec,
  zoom,
}: {
  onMoveClip: (direction: -1 | 1) => void
  onSelect: (selection: EditorSelection) => void
  onSplit: () => void
  onZoomChange: (zoom: number) => void
  readOnly: boolean
  regionRef: RefObject<HTMLElement | null>
  selection: EditorSelection | null
  snapshot: EditorCompositionSnapshot
  playheadSec: number
  zoom: number
}) {
  const duration = snapshot.canvas.durationSec
  const playheadPercent = Math.max(0, Math.min(100, (playheadSec / duration) * 100))
  const laneWidth = Math.max(760, duration * zoom)
  const rulerMarks = Array.from({ length: 7 }, (_, index) => (
    roundTime((duration / 6) * index)
  ))
  const style = {
    '--timeline-lane-width': `${laneWidth}px`,
    '--timeline-playhead': `${playheadPercent}%`,
  } as CSSProperties
  const selectedTrack = snapshot.tracks.find((track) => track.id === selection?.trackId)
  const selectedIndex = selectedTrack?.clips.findIndex((clip) => clip.id === selection?.clipId) ?? -1
  const canMoveBack = selectedIndex > 0
  const canMoveForward = Boolean(selectedTrack && selectedIndex >= 0 && selectedIndex < selectedTrack.clips.length - 1)

  return (
    <section
      aria-label="Synchronized multi-track timeline"
      className={styles.timelineRegion}
      id="studio-editor-timeline"
      ref={regionRef}
      style={style}
      tabIndex={-1}
    >
      <header className={styles.timelineHeader}>
        <div>
          <span>TIMELINE</span>
          <strong>{snapshot.tracks.length} synchronized tracks</strong>
          <small>{snapshot.tracks.reduce((count, track) => count + track.clips.length, 0)} clips · v{snapshot.version}</small>
        </div>
        <div className={styles.timelineActions}>
          <button
            aria-label="Move selected clip earlier"
            disabled={readOnly || !canMoveBack}
            onClick={() => onMoveClip(-1)}
            type="button"
          >
            <EditorIcon name="chevron-left" size={14} />
          </button>
          <button
            aria-label="Move selected clip later"
            disabled={readOnly || !canMoveForward}
            onClick={() => onMoveClip(1)}
            type="button"
          >
            <EditorIcon name="chevron-right" size={14} />
          </button>
          <button
            aria-keyshortcuts="S"
            aria-label="Split selected clip at playhead"
            disabled={readOnly}
            onClick={onSplit}
            type="button"
          >
            <EditorIcon name="scissors" size={14} />
          </button>
          <span className={styles.timelineZoom}>
            <EditorIcon name="zoom-out" size={13} />
            <label>
              <span className={styles.srOnly}>Timeline zoom</span>
              <input
                max={80}
                min={24}
                onChange={(event) => onZoomChange(Number(event.target.value))}
                step={4}
                type="range"
                value={zoom}
              />
            </label>
            <EditorIcon name="zoom-in" size={13} />
          </span>
        </div>
      </header>

      <div className={styles.timelineScroller}>
        <div className={styles.timelineContent}>
          <div className={styles.timelineCorner}>
            <span>TRACK</span>
            <kbd>⌘Z</kbd>
          </div>
          <div className={styles.timelineRuler}>
            {rulerMarks.map((time) => (
              <span
                key={time}
                style={{ left: `${(time / duration) * 100}%` }}
              >
                {formatEditorTime(time)}
              </span>
            ))}
          </div>

          {snapshot.tracks.map((track) => (
            <div className={styles.timelineRow} key={track.id}>
              <button
                aria-label={`${track.label} track`}
                aria-pressed={selection?.trackId === track.id}
                className={styles.timelineTrackLabel}
                onClick={() => {
                  const first = track.clips[0]
                  if (first) onSelect({ trackId: track.id, clipId: first.id })
                }}
                type="button"
              >
                <span>
                  <EditorIcon name={trackIcon(track.kind)} size={14} />
                </span>
                <strong>{track.label}</strong>
                <small>{track.muted ? 'Muted' : track.locked ? 'Locked' : `${track.clips.length} clip${track.clips.length === 1 ? '' : 's'}`}</small>
              </button>
              <div className={styles.timelineLane}>
                {track.clips.map((clip) => {
                  const left = (clip.startSec / duration) * 100
                  const width = Math.max(0.6, ((clip.endSec - clip.startSec) / duration) * 100)
                  const selected = selection?.clipId === clip.id
                  const audio = clip.kind === 'voice' || clip.kind === 'music' || clip.kind === 'sfx'
                  return (
                    <button
                      aria-label={`${clip.label}, ${formatEditorTime(clip.startSec)} to ${formatEditorTime(clip.endSec)}, ${statusLabel(clip.status)}`}
                      aria-pressed={selected}
                      className={`${styles.timelineClip} ${selected ? styles.timelineClipSelected : ''}`}
                      data-kind={clip.kind}
                      data-status={clip.status}
                      key={clip.id}
                      onClick={() => onSelect({ trackId: track.id, clipId: clip.id })}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      type="button"
                    >
                      {audio && <Waveform clip={clip} />}
                      <span>
                        <strong>{clip.label}</strong>
                        <small>
                          {formatEditorTime(clip.startSec)} · {statusLabel(clip.status)}
                        </small>
                      </span>
                      {clip.status === 'queued' || clip.status === 'running' ? (
                        <em>Not complete</em>
                      ) : null}
                    </button>
                  )
                })}
                <span className={styles.timelinePlayhead} aria-hidden="true">
                  <i />
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function roundTime(value: number): number {
  return Math.round(value * 10) / 10
}
