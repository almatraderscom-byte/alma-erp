'use client'

/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import type {
  GalleryItem,
  SavedStudioModel,
  StudioBrandProfile,
  StudioMusicTrack,
  StudioVideoUpload,
} from '@/agent/components/creative-studio/studio-api'
import {
  AUDIO_MODES,
  VIDEO_ASPECTS,
  VIDEO_RECIPES,
  reelCostBdt,
  type VideoAudioMode,
} from '@/lib/creative-studio/video-recipes'
import { VIDEO_VIBES } from '@/lib/creative-studio/constants'
import { StudioConfirmationDialog } from '@/agent/components/creative-studio/StudioUi'
import { StudioV3Icon } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import {
  STUDIO_V3_SCOPE_BOUNDARY,
  type CreativeStudioV3ProductionPort,
} from '@/agent/components/creative-studio-v3/ports'
import type { CreativeStudioV3Navigate } from '@/agent/components/creative-studio-v3/types'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

type VideoLabData = {
  sources: GalleryItem[]
  models: SavedStudioModel[]
  uploads: StudioVideoUpload[]
  music: StudioMusicTrack[]
  issues: string[]
}

const EMPTY_DATA: VideoLabData = {
  sources: [],
  models: [],
  uploads: [],
  music: [],
  issues: [],
}

function galleryPath(item: GalleryItem | null): string | null {
  return item?.originalVariant?.storagePath ?? item?.storagePath ?? null
}

export function StudioV3VideoLab({
  activeBrand,
  initialAvatarId,
  initialSourceAssetId,
  onNavigate,
  port,
}: {
  activeBrand: StudioBrandProfile | null
  initialAvatarId?: string
  initialSourceAssetId?: string
  onNavigate: CreativeStudioV3Navigate
  port: CreativeStudioV3ProductionPort
}) {
  const [data, setData] = useState<VideoLabData>(EMPTY_DATA)
  const [loading, setLoading] = useState(true)
  const [workspaceTab, setWorkspaceTab] = useState<'explore' | 'history'>('explore')
  const [sourceMode, setSourceMode] = useState<'gallery' | 'avatar' | 'owned'>('gallery')
  const [selectedSourceId, setSelectedSourceId] = useState(initialSourceAssetId ?? '')
  const [selectedAvatarId, setSelectedAvatarId] = useState(initialAvatarId ?? '')
  const [selectedUploadId, setSelectedUploadId] = useState('')
  const [duration, setDuration] = useState(6)
  const [aspect, setAspect] = useState('9:16')
  const [vibe, setVibe] = useState<'premium' | 'festival' | 'offer' | 'lifestyle'>('premium')
  const [prompt, setPrompt] = useState('')
  const [recipeId, setRecipeId] = useState(VIDEO_RECIPES[0].id)
  const [audioMode, setAudioMode] = useState<VideoAudioMode>('original')
  const [musicTrackId, setMusicTrackId] = useState('auto')
  const [captions, setCaptions] = useState(false)
  const [voiceover, setVoiceover] = useState('')
  const [stings, setStings] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [queueing, setQueueing] = useState(false)
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const videoInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    void Promise.allSettled([
      port.listGallery(
        { media: 'image', state: 'ready', limit: 24 },
        activeBrand?.brandProfileId,
      ),
      port.listModels(activeBrand?.brandProfileId),
      port.listVideoUploads(activeBrand?.brandProfileId),
      port.listMusicTracks(activeBrand?.brandProfileId),
    ]).then((results) => {
      if (!live) return
      const issues: string[] = []
      const take = <T,>(index: number, label: string, fallback: T): T => {
        const result = results[index]
        if (result.status === 'fulfilled') return result.value as T
        issues.push(`${label}: ${result.reason instanceof Error ? result.reason.message : 'unavailable'}`)
        return fallback
      }
      const next: VideoLabData = {
        sources: take<{ items: GalleryItem[] }>(0, 'Gallery', { items: [] }).items,
        models: take(1, 'Avatars', []),
        uploads: take(2, 'Owned footage', []),
        music: take(3, 'Music library', []),
        issues,
      }
      setData(next)
      setSelectedSourceId((current) => current || next.sources[0]?.id || '')
      setSelectedAvatarId((current) => current || next.models[0]?.id || '')
      setSelectedUploadId((current) => current || next.uploads[0]?.id || '')
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [activeBrand?.brandProfileId, port])

  const selectedSource = data.sources.find((item) => item.id === selectedSourceId) ?? null
  const selectedAvatar = data.models.find((item) => item.id === selectedAvatarId) ?? null
  const selectedUpload = data.uploads.find((item) => item.id === selectedUploadId) ?? null
  const recipe = VIDEO_RECIPES.find((item) => item.id === recipeId) ?? VIDEO_RECIPES[0]
  const stillMode = sourceMode !== 'owned'
  const ownerActionAvailable = activeBrand?.role === 'owner'
  const startFramePath = sourceMode === 'gallery'
    ? galleryPath(selectedSource)
    : sourceMode === 'avatar'
      ? selectedAvatar?.imagePath ?? null
      : null
  const ready = stillMode
    ? Boolean(startFramePath && prompt.trim())
    : Boolean(selectedUpload && recipe.targets.includes(duration))

  useEffect(() => {
    if (stillMode) {
      if (!['9:16', '16:9'].includes(aspect)) setAspect('9:16')
      if (![6, 16, 24].includes(duration)) setDuration(6)
      return
    }
    if (!recipe.targets.includes(duration)) setDuration(recipe.defaultTarget)
  }, [aspect, duration, recipe, stillMode])

  const estimatedCost = stillMode ? reelCostBdt(duration) : 0
  const selectedSourceLabel = sourceMode === 'gallery'
    ? selectedSource?.summary ?? selectedSource?.mode ?? 'No Gallery source'
    : sourceMode === 'avatar'
      ? selectedAvatar?.name ?? 'No avatar source'
      : selectedUpload?.name ?? 'No owned footage'

  const uploadVideo = async (file: File | undefined) => {
    if (!file) return
    if (!ownerActionAvailable) {
      toast.error('Video upload is disabled until the collaborator-safe production adapter is connected.')
      return
    }
    setUploadPercent(0)
    try {
      const uploaded = await port.uploadVideo(file, setUploadPercent)
      setData((current) => ({ ...current, uploads: [uploaded, ...current.uploads.filter((item) => item.id !== uploaded.id)] }))
      setSelectedUploadId(uploaded.id)
      setSourceMode('owned')
      toast.success('Owned footage registered. No edit job has been queued.')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Video upload failed.')
    } finally {
      setUploadPercent(null)
      if (videoInput.current) videoInput.current.value = ''
    }
  }

  const queue = async () => {
    if (!ownerActionAvailable) {
      toast.error('Video queueing is disabled until the collaborator-safe production adapter is connected.')
      return
    }
    setQueueing(true)
    try {
      if (stillMode) {
        if (!startFramePath) throw new Error('Choose a valid gallery image or saved avatar source.')
        const result = await port.queueAdvancedImage({
          mode: 'image_to_video',
          provider: 'gemini',
          sourceImagePath: startFramePath,
          sourcePendingActionId: sourceMode === 'gallery' ? selectedSource?.id : undefined,
          prompt: prompt.trim(),
          aspectRatio: aspect,
          durationSec: duration,
          vibe,
        })
        toast.success(result.message)
      } else {
        if (!selectedUpload) throw new Error('Choose owned footage.')
        const result = await port.queueOwnedVideo({
          videoPath: selectedUpload.path,
          videoName: selectedUpload.name,
          recipeId: recipe.id,
          targets: [duration],
          aspect,
          options: {
            captions,
            audioMode,
            musicTrackId,
            voiceoverText: voiceover.trim() || undefined,
            stings,
          },
        })
        toast.success(result.message)
      }
      setReviewOpen(false)
      setWorkspaceTab('history')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'The server rejected the video request.')
    } finally {
      setQueueing(false)
    }
  }

  const availableDurations = stillMode ? [6, 16, 24] : recipe.targets
  const availableAspects = stillMode
    ? VIDEO_ASPECTS.filter((item) => item.id !== '1:1')
    : VIDEO_ASPECTS

  return (
    <div className={styles.page}>
      <input
        accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
        className="sr-only"
        disabled={!ownerActionAvailable}
        onChange={(event) => void uploadVideo(event.target.files?.[0])}
        ref={videoInput}
        type="file"
      />

      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceTitle}>
          <span><StudioV3Icon name="video" /></span>
          <div>
            <span className={styles.eyebrow}>Create / Explore</span>
            <h1>Video Lab</h1>
            <p>Source-first creation separates generated reels from deterministic owned-footage recipes.</p>
          </div>
        </div>
        <div className={styles.segmented}>
          <button aria-pressed={workspaceTab === 'explore'} onClick={() => setWorkspaceTab('explore')} type="button">Explore</button>
          <button aria-pressed={workspaceTab === 'history'} onClick={() => setWorkspaceTab('history')} type="button">History</button>
        </div>
      </header>

      {data.issues.length > 0 && (
        <div className={styles.inlineWarning}><StudioV3Icon name="warning" /><span>{data.issues.join(' · ')}</span></div>
      )}
      <p className={styles.scopeNotice}>
        <StudioV3Icon name="lock" />
        Brand switch reloaded this Lab. Sources, identities and owned media use legacy owner-only
        endpoints whose current records carry no brand key; no brand filter is implied
        ({STUDIO_V3_SCOPE_BOUNDARY.ownedMedia}).
      </p>
      {!ownerActionAvailable && (
        <div className={styles.truthBoundary}>
          <StudioV3Icon name="lock" />
          <div>
            <strong>{activeBrand?.role ?? 'Collaborator'} video actions are not connected yet</strong>
            <p>The V3 source-first journey remains inspectable, but upload and queue controls stay disabled while the legacy video routes remain owner-only.</p>
          </div>
        </div>
      )}

      {workspaceTab === 'history' ? (
        <section className={styles.historyPanel}>
          <header>
            <div><span className={styles.eyebrow}>Production status</span><h2>Video history belongs in Gallery</h2></div>
            <button onClick={() => onNavigate({ id: 'gallery', initialType: 'video' })} type="button">Open Video Gallery <StudioV3Icon name="arrow" /></button>
          </header>
          <div className={styles.truthBoundary}>
            <StudioV3Icon name="lock" />
            <div>
              <strong>A queue receipt is not a completed video.</strong>
              <p>Gallery polls the authenticated job API and exposes progress, verified artifact state, QC and any failure.</p>
            </div>
          </div>
          <div className={styles.ownedList}>
            {data.uploads.map((item) => (
              <button key={item.id} onClick={() => { setSourceMode('owned'); setSelectedUploadId(item.id); setWorkspaceTab('explore') }} type="button">
                <StudioV3Icon name="video" />
                <span><strong>{item.name}</strong><small>{Math.round(item.sizeBytes / (1024 * 1024))} MB · uploaded {new Date(item.uploadedAt).toLocaleDateString('en-BD')}</small></span>
                <StudioV3Icon name="arrow" />
              </button>
            ))}
          </div>
        </section>
      ) : (
        <div className={styles.labLayout}>
          <section aria-label="Video source explorer" className={styles.labExplore}>
            <div className={styles.sourceModeGrid}>
              {([
                ['gallery', 'image', 'Gallery image', 'Veo 3.1 source still'],
                ['avatar', 'voice', 'Saved avatar', 'Identity-guided start frame'],
                ['owned', 'video', 'Owned footage', 'Deterministic local recipe'],
              ] as const).map(([id, icon, title, detail]) => (
                <button aria-pressed={sourceMode === id} key={id} onClick={() => setSourceMode(id)} type="button">
                  <StudioV3Icon name={icon} />
                  <span><strong>{title}</strong><small>{detail}</small></span>
                </button>
              ))}
            </div>

            {sourceMode === 'gallery' && (
              <section className={styles.sourceSection}>
                <header><div><span className={styles.eyebrow}>Ready images</span><h2>Choose the start frame</h2></div><button onClick={() => onNavigate({ id: 'gallery', initialType: 'image' })} type="button">Full Gallery</button></header>
                {loading ? <div className={styles.laneSkeleton} /> : data.sources.length === 0 ? (
                  <p className={styles.emptyState}>The Gallery API returned no ready image source.</p>
                ) : (
                  <div className={styles.mediaLane}>
                    {data.sources.map((item) => (
                      <button aria-pressed={selectedSourceId === item.id} className={selectedSourceId === item.id ? styles.mediaChoiceActive : styles.mediaChoice} key={item.id} onClick={() => setSelectedSourceId(item.id)} type="button">
                        <span>{item.thumbUrl || item.previewUrl ? <img alt="" src={item.thumbUrl ?? item.previewUrl ?? ''} /> : <StudioV3Icon name="image" />}</span>
                        <strong>{item.summary ?? item.mode}</strong>
                        <small>{item.provider} · {item.originalVariant ? `${item.originalVariant.width}×${item.originalVariant.height}` : item.assetState}</small>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            {sourceMode === 'avatar' && (
              <section className={styles.sourceSection}>
                <header><div><span className={styles.eyebrow}>Saved identity</span><h2>Choose an avatar start frame</h2></div><button onClick={() => onNavigate({ id: 'desk', desk: 'systems' })} type="button">Manage avatars</button></header>
                {data.models.length === 0 ? <p className={styles.emptyState}>No saved identity source is available.</p> : (
                  <div className={styles.identityLane}>
                    {data.models.map((model) => (
                      <button aria-pressed={selectedAvatarId === model.id} key={model.id} onClick={() => setSelectedAvatarId(model.id)} type="button">
                        <span>{model.imageUrl ? <img alt="" src={model.imageUrl} /> : <StudioV3Icon name="voice" />}</span>
                        <strong>{model.name}</strong>
                        <small>{model.role ?? 'No role'} · {model.avatar?.built ? `${model.avatar.count} angles` : 'single reference'}</small>
                      </button>
                    ))}
                  </div>
                )}
                <p className={styles.truthNote}>Veo receives one source still in the current API. A separate product/person fidelity pair is not accepted.</p>
              </section>
            )}

            {sourceMode === 'owned' && (
              <>
                <section className={styles.sourceSection}>
                  <header><div><span className={styles.eyebrow}>Owned footage</span><h2>Choose an uploaded shoot</h2></div><button disabled={!ownerActionAvailable} onClick={() => videoInput.current?.click()} type="button">Upload video</button></header>
                  {uploadPercent !== null && <div className={styles.uploadProgress}><span style={{ width: `${uploadPercent}%` }} /><strong>{uploadPercent}%</strong></div>}
                  {data.uploads.length === 0 ? <p className={styles.emptyState}>No owned footage is registered. Upload verifies the storage object before it enters the library.</p> : (
                    <div className={styles.ownedList}>
                      {data.uploads.map((item) => (
                        <button aria-pressed={selectedUploadId === item.id} key={item.id} onClick={() => setSelectedUploadId(item.id)} type="button">
                          <StudioV3Icon name="video" />
                          <span><strong>{item.name}</strong><small>{Math.round(item.sizeBytes / (1024 * 1024))} MB · {new Date(item.uploadedAt).toLocaleDateString('en-BD')}</small></span>
                          {selectedUploadId === item.id && <StudioV3Icon name="check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </section>
                <section className={styles.sourceSection}>
                  <header><div><span className={styles.eyebrow}>Deterministic templates</span><h2>Owned-footage recipe</h2></div></header>
                  <div className={styles.recipeCards}>
                    {VIDEO_RECIPES.map((item) => (
                      <button aria-pressed={recipeId === item.id} key={item.id} onClick={() => setRecipeId(item.id)} type="button">
                        <strong>{item.label}</strong>
                        <small>{item.descriptionBn}</small>
                        <em>{item.targets.join(' / ')} sec · {item.transition}</em>
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}
          </section>

          <aside aria-label="Video generation composer" className={styles.composer}>
            <header className={styles.composerHeader}>
              <div><span className={styles.eyebrow}>Source-first composer</span><h2>{stillMode ? 'Generated reel' : 'Owned-footage edit'}</h2></div>
              <span className={styles.serverBadge}><StudioV3Icon name="lock" /> Server authority</span>
            </header>
            <div className={styles.composerBody}>
              <div className={styles.selectionSummary}>
                <div><span>Source</span><strong>{selectedSourceLabel}</strong></div>
                <div><span>Model</span><strong>{stillMode ? 'Veo 3.1' : 'ffmpeg recipe engine'}</strong></div>
                <div><span>Brand</span><strong>{activeBrand?.name ?? 'Server access context'}</strong></div>
              </div>

              <fieldset className={styles.optionGroup}>
                <legend>Duration</legend>
                <div className={styles.chipRow}>
                  {availableDurations.map((value) => <button aria-pressed={duration === value} key={value} onClick={() => setDuration(value)} type="button">{value}s</button>)}
                </div>
                {stillMode && duration >= 16 && <p className={styles.optionHelp}>{duration === 16 ? '2 × 8-second' : '3 × 8-second'} Veo chain, then deterministic ffmpeg assembly.</p>}
              </fieldset>

              <fieldset className={styles.optionGroup}>
                <legend>Resolution</legend>
                <div className={styles.resolutionGrid}>
                  <button aria-pressed type="button"><strong>{stillMode ? '720p' : 'Source'}</strong><small>{stillMode ? 'Current verified delivery tier' : 'Preserve up to 1080p'}</small></button>
                  <button disabled type="button"><strong>1080p</strong><small>{stillMode ? 'Not in current Veo contract' : 'Depends on source'}</small></button>
                  <button disabled type="button"><strong>4K</strong><small>Unsupported</small></button>
                </div>
                <p className={styles.optionHelp}>Requested labels never override delivered dimensions; Gallery result metadata is authoritative.</p>
              </fieldset>

              <fieldset className={styles.optionGroup}>
                <legend>Aspect</legend>
                <div className={styles.chipRow}>
                  {VIDEO_ASPECTS.map((item) => (
                    <button aria-pressed={aspect === item.id} disabled={!availableAspects.some((entry) => entry.id === item.id)} key={item.id} onClick={() => setAspect(item.id)} type="button">{item.id}</button>
                  ))}
                </div>
              </fieldset>

              {stillMode ? (
                <>
                  <fieldset className={styles.optionGroup}>
                    <legend>Frames</legend>
                    <div className={styles.frameGrid}>
                      <div data-ready={Boolean(startFramePath)}><span>{sourceMode === 'gallery' && selectedSource?.previewUrl ? <img alt="" src={selectedSource.previewUrl} /> : sourceMode === 'avatar' && selectedAvatar?.imageUrl ? <img alt="" src={selectedAvatar.imageUrl} /> : <StudioV3Icon name="image" />}</span><strong>Start frame</strong><small>{startFramePath ? 'Server-resolved source' : 'Required'}</small></div>
                      <div aria-disabled="true"><span><StudioV3Icon name="lock" /></span><strong>End frame</strong><small>Foundation adapter required</small></div>
                    </div>
                  </fieldset>
                  <label className={styles.field}><span>Motion prompt <em>Required</em></span><textarea maxLength={1_200} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe camera movement, material motion and final beat…" rows={4} value={prompt} /></label>
                  <fieldset className={styles.optionGroup}>
                    <legend>Motion recipe</legend>
                    <div className={styles.chipRow}>{VIDEO_VIBES.map((item) => <button aria-pressed={vibe === item.id} key={item.id} onClick={() => setVibe(item.id)} type="button">{item.label}</button>)}</div>
                  </fieldset>
                  <fieldset className={styles.optionGroup}>
                    <legend>Audio</legend>
                    <div className={styles.engineList}>
                      <button aria-pressed type="button"><span><strong>Provider default</strong><small>Current production request contract</small></span><em>Supported</em></button>
                      <button disabled type="button"><span><strong>Mute</strong><small>Explicit audio adapter not connected</small></span><em>Blocked</em></button>
                      <button disabled type="button"><span><strong>Generate audio</strong><small>Explicit provider capability required</small></span><em>Blocked</em></button>
                    </div>
                  </fieldset>
                </>
              ) : (
                <>
                  <fieldset className={styles.optionGroup}>
                    <legend>Audio</legend>
                    <div className={styles.chipRow}>{AUDIO_MODES.map((item) => <button aria-pressed={audioMode === item.id} key={item.id} onClick={() => setAudioMode(item.id)} type="button">{item.labelBn}</button>)}</div>
                    {audioMode !== 'original' && (
                      <label className={styles.field}><span>Approved music</span><select onChange={(event) => setMusicTrackId(event.target.value)} value={musicTrackId}><option value="auto">Auto from approved library</option>{data.music.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                    )}
                  </fieldset>
                  <label className={styles.toggleRow}><span><strong>Captions</strong><small>Mechanical transcript/caption path.</small></span><input checked={captions} onChange={(event) => setCaptions(event.target.checked)} type="checkbox" /></label>
                  <label className={styles.toggleRow}><span><strong>Logo sting</strong><small>Requires existing brand logo.</small></span><input checked={stings} onChange={(event) => setStings(event.target.checked)} type="checkbox" /></label>
                  <label className={styles.field}><span>Human-authored voiceover</span><textarea maxLength={220} onChange={(event) => setVoiceover(event.target.value)} placeholder="Optional fixed line; no LLM authorship" rows={3} value={voiceover} /></label>
                </>
              )}

              <div className={styles.readiness} data-ready={ready}>
                <StudioV3Icon name={ready ? 'check' : 'warning'} />
                <div>
                  <strong>{ready ? 'Ready for authorized review' : 'Source or required input missing'}</strong>
                  <span>{stillMode ? `Estimated ceiling shown for review: ৳${estimatedCost.toLocaleString('en-BD')}. Server is authoritative.` : 'Local edit path is ৳0; server validates source, recipe and brand assets.'}</span>
                </div>
              </div>
              <button className={styles.primaryButton} disabled={!ownerActionAvailable || !ready} onClick={() => setReviewOpen(true)} type="button">Review queue request <StudioV3Icon name="arrow" /></button>
            </div>
          </aside>
        </div>
      )}

      <StudioConfirmationDialog
        ariaLabel="Review video queue request"
        confirmDisabled={!ownerActionAvailable || !ready || queueing}
        confirmLabel={queueing ? 'Server checking…' : 'Confirm and send to server gate'}
        onCancel={() => setReviewOpen(false)}
        onConfirm={() => void queue()}
        open={reviewOpen}
        summary={stillMode
          ? 'This can create paid Veo jobs. The authenticated server re-validates source QC, provider readiness, duration chain and cost policy before queueing.'
          : 'This queues a server-validated local edit job. The immutable owned source remains preserved.'}
        title={stillMode ? 'Queue generated reel?' : 'Queue owned-footage edit?'}
      >
        <dl className={styles.confirmationFacts}>
          <div><dt>Source</dt><dd>{selectedSourceLabel}</dd></div>
          <div><dt>Model / recipe</dt><dd>{stillMode ? 'Veo 3.1' : recipe.label}</dd></div>
          <div><dt>Duration</dt><dd>{duration}s{stillMode && duration >= 16 ? ' chained' : ''}</dd></div>
          <div><dt>Resolution</dt><dd>{stillMode ? '720p delivery contract; verified result wins' : 'source-preserving, up to 1080p'}</dd></div>
          <div><dt>Audio</dt><dd>{stillMode ? 'provider default only' : AUDIO_MODES.find((item) => item.id === audioMode)?.labelBn}</dd></div>
          <div><dt>Cost</dt><dd>{stillMode ? `estimated ৳${estimatedCost.toLocaleString('en-BD')}; server cap applies` : '৳0 local worker'}</dd></div>
        </dl>
      </StudioConfirmationDialog>
    </div>
  )
}
