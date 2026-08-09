'use client'

/* eslint-disable @next/next/no-img-element */

import type { CSSProperties, RefObject } from 'react'
import type { EditorCompositionSnapshot } from '@/lib/creative-studio/editor-agent'
import { EditorIcon } from './EditorIcon'
import {
  activeVisualClip,
  formatEditorTime,
  selectedEditorClip,
} from './editor-utils'
import type { EditorSelection } from './ui-types'
import styles from './ProjectEditor.module.css'

export function EditorStage({
  onPlayToggle,
  onSeek,
  onSelect,
  onSplit,
  playing,
  playheadSec,
  readOnly,
  regionRef,
  selection,
  snapshot,
}: {
  onPlayToggle: () => void
  onSeek: (seconds: number) => void
  onSelect: (selection: EditorSelection) => void
  onSplit: () => void
  playing: boolean
  playheadSec: number
  readOnly: boolean
  regionRef: RefObject<HTMLElement | null>
  selection: EditorSelection | null
  snapshot: EditorCompositionSnapshot
}) {
  const activeVisual = activeVisualClip(snapshot, playheadSec)
  const activeAsset = activeVisual?.assetVersionId
    ? snapshot.assets.find((asset) =>
      asset.assetVersionId === activeVisual.assetVersionId) ?? null
    : null
  const selected = selectedEditorClip(snapshot, selection)
  const captionTrack = snapshot.tracks.find((track) => track.kind === 'caption')
  const activeCaption = captionTrack?.clips.find(
    (clip) => playheadSec >= clip.startSec && playheadSec <= clip.endSec,
  ) ?? null
  const overlayTrack = snapshot.tracks.find((track) => track.kind === 'overlay')
  const activeOverlays = overlayTrack?.clips.filter(
    (clip) => playheadSec >= clip.startSec && playheadSec <= clip.endSec,
  ) ?? []
  const selectedTransform = selected?.clip.transform
  const frameStyle = {
    '--stage-aspect': snapshot.canvas.aspectRatio.replace(':', ' / '),
    '--stage-accent': snapshot.canvas.background,
  } as CSSProperties

  return (
    <section
      aria-label="Composition stage and player"
      className={styles.stageRegion}
      id="studio-editor-stage"
      ref={regionRef}
      tabIndex={-1}
    >
      <header className={styles.stageHeader}>
        <div>
          <span>CANVAS</span>
          <strong>{snapshot.canvas.aspectRatio}</strong>
          <small>{snapshot.canvas.width} × {snapshot.canvas.height}</small>
        </div>
        <div className={styles.stageTruth}>
          <span>
            <EditorIcon name="check" size={12} />
            {activeAsset?.previewUrl
              ? 'Access-scoped preview'
              : 'Preview not hydrated'}
          </span>
          <span>
            <EditorIcon name="safe-zone" size={12} />
            Safe zone {snapshot.canvas.safeZone ? 'on' : 'off'}
          </span>
        </div>
      </header>

      <div className={styles.stageViewport}>
        <button
          aria-label={`Select active clip ${activeVisual?.label ?? ''}`}
          className={styles.stageCanvas}
          data-frame={activeVisual?.id ?? 'empty'}
          onClick={() => {
            if (activeVisual) {
              onSelect({ trackId: activeVisual.trackId, clipId: activeVisual.id })
            }
          }}
          style={frameStyle}
          type="button"
        >
          <span className={styles.stageArtwork}>
            {activeAsset?.previewUrl ? (
              <img
                alt=""
                className={styles.stagePreviewMedia}
                src={activeAsset.previewUrl}
              />
            ) : (
              <span className={styles.stagePreviewUnavailable}>
                <EditorIcon name="assets" size={28} />
                <strong>Preview not hydrated</strong>
                <small>
                  Canonical clip and asset-version pins are still loaded.
                </small>
              </span>
            )}
            <span className={styles.stageProductCode}>
              {snapshot.productCode ?? 'NO PRODUCT'}
            </span>
            <span className={styles.stageEditorial}>
              <span>{snapshot.projectName}</span>
              <strong>{activeVisual?.label ?? 'No visual at playhead'}</strong>
              <small>
                {activeAsset
                  ? `${activeAsset.status} · ${activeAsset.assetVersionId}`
                  : 'No asset metadata was returned'}
              </small>
            </span>
          </span>

          {activeOverlays.map((overlay) => (
            <span
              className={`${styles.stageOverlay} ${
                selection?.clipId === overlay.id ? styles.stageSelectedNode : ''
              }`}
              key={overlay.id}
              style={{
                opacity: overlay.transform.opacity,
                transform: `translate(${overlay.transform.x * 40}px, ${overlay.transform.y * 40}px) scale(${overlay.transform.scale}) rotate(${overlay.transform.rotation}deg)`,
              }}
            >
              {overlay.text ?? overlay.label}
            </span>
          ))}

          {activeCaption && (
            <span
              className={`${styles.stageCaption} ${
                selection?.clipId === activeCaption.id ? styles.stageSelectedNode : ''
              }`}
              style={{
                opacity: activeCaption.transform.opacity,
                transform: `translate(${activeCaption.transform.x * 40}px, ${activeCaption.transform.y * 40}px) scale(${activeCaption.transform.scale}) rotate(${activeCaption.transform.rotation}deg)`,
              }}
            >
              {activeCaption.text}
            </span>
          )}

          {snapshot.canvas.safeZone && (
            <span className={styles.stageSafeZone} aria-hidden="true" />
          )}
          <span className={styles.stagePrototype}>EDIT PREVIEW · LOCAL PROXY</span>

          {selected && selected.clip.kind !== 'voice' && selected.clip.kind !== 'music' && selected.clip.kind !== 'sfx' && (
            <span
              aria-hidden="true"
              className={styles.stageSelectionBox}
              style={{
                opacity: selectedTransform?.opacity ?? 1,
                transform: `translate(${(selectedTransform?.x ?? 0) * 20}px, ${(selectedTransform?.y ?? 0) * 20}px) scale(${selectedTransform?.scale ?? 1}) rotate(${selectedTransform?.rotation ?? 0}deg)`,
              }}
            >
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
        </button>
      </div>

      <div className={styles.playerControls}>
        <button
          aria-keyshortcuts="Space"
          aria-label={playing ? 'Pause composition' : 'Play composition'}
          className={styles.playButton}
          onClick={onPlayToggle}
          type="button"
        >
          <EditorIcon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <span className={styles.playerTime}>
          {formatEditorTime(playheadSec)}
          <small>/ {formatEditorTime(snapshot.canvas.durationSec)}</small>
        </span>
        <label className={styles.playerScrubber}>
          <span className={styles.srOnly}>Playhead time</span>
          <input
            aria-valuetext={formatEditorTime(playheadSec)}
            max={snapshot.canvas.durationSec}
            min={0}
            onChange={(event) => onSeek(Number(event.target.value))}
            step={0.1}
            type="range"
            value={playheadSec}
          />
        </label>
        <span className={styles.selectionReadout}>
          {selected?.clip.label ?? 'No selection'}
        </span>
        <button
          aria-keyshortcuts="S"
          className={styles.splitButton}
          disabled={readOnly || !activeVisual}
          onClick={onSplit}
          type="button"
        >
          <EditorIcon name="scissors" size={15} />
          Split
        </button>
      </div>
    </section>
  )
}
