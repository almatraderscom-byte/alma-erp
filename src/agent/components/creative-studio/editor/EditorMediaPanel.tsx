'use client'

import { useMemo, useState } from 'react'
import type { EditorClipKind, EditorCompositionSnapshot } from '@/lib/creative-studio/editor-agent'
import { EditorIcon, type EditorIconName } from './EditorIcon'
import { statusLabel, trackKindLabel } from './editor-utils'
import type { EditorSelection, EditorTool } from './ui-types'
import styles from './ProjectEditor.module.css'

const TOOLS: ReadonlyArray<{
  id: EditorTool
  label: string
  icon: EditorIconName
}> = [
  { id: 'project', label: 'Project', icon: 'project' },
  { id: 'media', label: 'Media', icon: 'assets' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'video', label: 'Video', icon: 'video' },
  { id: 'image', label: 'Image', icon: 'image' },
  { id: 'caption', label: 'Captions', icon: 'caption' },
  { id: 'voice', label: 'Voice', icon: 'voice' },
  { id: 'music', label: 'Music', icon: 'music' },
  { id: 'sfx', label: 'SFX', icon: 'sfx' },
]

const TOOL_MEDIA_KIND: Partial<Record<EditorTool, EditorClipKind>> = {
  video: 'video',
  image: 'image',
  caption: 'caption',
  voice: 'voice',
  music: 'music',
  sfx: 'sfx',
}

export function EditorMediaPanel({
  activeTool,
  onSelect,
  onSelectAsset,
  onToolChange,
  selectedAssetId,
  selection,
  snapshot,
}: {
  activeTool: EditorTool
  onSelect: (selection: EditorSelection) => void
  onSelectAsset: (assetId: string) => void
  onToolChange: (tool: EditorTool) => void
  selectedAssetId: string | null
  selection: EditorSelection | null
  snapshot: EditorCompositionSnapshot
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase('bn-BD')
  const mediaKind = TOOL_MEDIA_KIND[activeTool]
  const filteredAssets = useMemo(
    () => snapshot.assets.filter((asset) => {
      if (activeTool === 'library' && asset.status !== 'approved') return false
      if (mediaKind && asset.mediaType !== mediaKind) return false
      if (!normalizedQuery) return true
      return `${asset.title} ${asset.provider ?? ''} ${asset.engine ?? ''}`
        .toLocaleLowerCase('bn-BD')
        .includes(normalizedQuery)
    }),
    [activeTool, mediaKind, normalizedQuery, snapshot.assets],
  )

  return (
    <aside className={styles.leftRegion} aria-label="Project tools and media">
      <nav className={styles.toolRail} aria-label="Editor tools">
        {TOOLS.map((tool, index) => (
          <button
            aria-label={tool.label}
            aria-pressed={activeTool === tool.id}
            className={activeTool === tool.id ? styles.toolRailActive : undefined}
            key={tool.id}
            onClick={() => onToolChange(tool.id)}
            type="button"
          >
            <EditorIcon name={tool.icon} size={18} />
            <span>{tool.label}</span>
            {index === 2 && <i aria-hidden="true" />}
          </button>
        ))}
      </nav>

      <section className={styles.mediaPanel} aria-label={`${activeTool} panel`}>
        <header className={styles.mediaPanelHeader}>
          <div>
            <span>{activeTool === 'project' ? 'PROJECT DOCUMENT' : 'SOURCE BROWSER'}</span>
            <h2>{activeTool[0].toUpperCase() + activeTool.slice(1)}</h2>
          </div>
          <span className={styles.mediaCount}>
            {activeTool === 'project' ? snapshot.tracks.length : filteredAssets.length}
          </span>
        </header>

        {activeTool !== 'project' && (
          <label className={styles.mediaSearch}>
            <span className={styles.srOnly}>Search Studio assets</span>
            <EditorIcon name="search" size={15} />
            <input
              aria-keyshortcuts="Meta+K Control+K"
              id="studio-editor-media-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search source, provider…"
              type="search"
              value={query}
            />
            <kbd>⌘K</kbd>
          </label>
        )}

        <div className={styles.mediaPanelBody}>
          {activeTool === 'project' ? (
            <>
              <section className={styles.projectContextCard}>
                <span className={styles.projectContextMark}>AL</span>
                <div>
                  <strong>{snapshot.projectName}</strong>
                  <small>
                    {snapshot.productCode ?? 'No ERP product'} · {snapshot.recipeName ?? 'No recipe'}
                    {snapshot.recipeVersion ? ` v${snapshot.recipeVersion}` : ''}
                  </small>
                </div>
                <span>v{snapshot.version}</span>
              </section>
              <div className={styles.projectTree}>
                {snapshot.tracks.map((track) => (
                  <section key={track.id}>
                    <header>
                      <span>
                        <EditorIcon
                          name={
                            track.kind === 'caption'
                              ? 'caption'
                              : track.kind === 'voice'
                                ? 'voice'
                                : track.kind === 'music'
                                  ? 'music'
                                  : track.kind === 'sfx'
                                    ? 'sfx'
                                    : track.kind === 'overlay'
                                      ? 'layers'
                                      : 'video'
                          }
                          size={14}
                        />
                        {trackKindLabel(track.kind)}
                      </span>
                      <em>{track.clips.length}</em>
                    </header>
                    {track.clips.map((clip) => {
                      const selected = selection?.clipId === clip.id
                      return (
                        <button
                          aria-pressed={selected}
                          className={selected ? styles.projectTreeSelected : undefined}
                          key={clip.id}
                          onClick={() => onSelect({ trackId: track.id, clipId: clip.id })}
                          type="button"
                        >
                          <span className={styles.treeStatus} data-status={clip.status} />
                          <span>
                            <strong>{clip.label}</strong>
                            <small>{statusLabel(clip.status)} · {clip.id}</small>
                          </span>
                        </button>
                      )
                    })}
                  </section>
                ))}
              </div>
            </>
          ) : filteredAssets.length > 0 ? (
            <div className={styles.assetList}>
              {filteredAssets.map((asset, index) => {
                const placedClip = snapshot.tracks
                  .flatMap((track) => track.clips)
                  .find((clip) => clip.assetId === asset.assetId)
                return (
                  <button
                    aria-pressed={selectedAssetId === asset.assetId}
                    className={selectedAssetId === asset.assetId ? styles.assetCardSelected : undefined}
                    key={asset.assetVersionId}
                    onClick={() => {
                      onSelectAsset(asset.assetId)
                      if (placedClip) {
                        onSelect({ trackId: placedClip.trackId, clipId: placedClip.id })
                      }
                    }}
                    type="button"
                  >
                    <span className={styles.assetThumb} data-tone={String(index % 5)}>
                      <EditorIcon
                        name={
                          asset.mediaType === 'video'
                            ? 'video'
                            : asset.mediaType === 'voice'
                              ? 'voice'
                              : asset.mediaType === 'music'
                                ? 'music'
                                : asset.mediaType === 'sfx'
                                  ? 'sfx'
                                  : 'image'
                        }
                        size={19}
                      />
                      <small>{asset.artifact?.requestedAspectRatio ?? asset.mediaType}</small>
                    </span>
                    <span className={styles.assetCopy}>
                      <strong>{asset.title}</strong>
                      <small>{asset.provider ?? 'ALMA local'} · {asset.status}</small>
                      <em>{placedClip ? 'In composition' : 'Source only'}</em>
                    </span>
                    <span
                      aria-label={asset.qcLabel ?? asset.status}
                      className={styles.assetState}
                      data-state={asset.status}
                    />
                  </button>
                )
              })}
            </div>
          ) : (
            <div className={styles.emptyPanel}>
              <EditorIcon name="assets" size={24} />
              <strong>No matching source</strong>
              <p>Change the tool or clear the search. No provider request was made.</p>
              <button onClick={() => setQuery('')} type="button">Clear search</button>
            </div>
          )}
        </div>

        <footer className={styles.mediaPolicyFooter}>
          <EditorIcon name="lock" size={13} />
          Brand isolated · source versions pinned
        </footer>
      </section>
    </aside>
  )
}
