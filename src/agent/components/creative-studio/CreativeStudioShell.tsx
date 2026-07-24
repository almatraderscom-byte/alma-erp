'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion } from 'framer-motion'
import { Toaster } from 'react-hot-toast'
import { cn } from '@/lib/utils'
import { AudioLabView } from '@/agent/components/creative-studio/AudioLabView'
import { GalleryView } from '@/agent/components/creative-studio/GalleryView'
import { ModelLibraryView } from '@/agent/components/creative-studio/ModelLibraryView'
import { ProjectBar } from '@/agent/components/creative-studio/ProjectBar'
import { ProjectLibraryView } from '@/agent/components/creative-studio/ProjectLibraryView'
import { StudioWorkspaceView, ENGINE_LABELS_BN } from '@/agent/components/creative-studio/StudioWorkspaceView'
import { VideoStudioView } from '@/agent/components/creative-studio/VideoStudioView'
import { AudioSvg, GallerySvg, StudioSvg, UserSvg, VideoSvg } from '@/agent/components/creative-studio/StudioUi'
import {
  fetchStudioConfig,
  STUDIO_NAV_DEFINITIONS,
  type StudioConfig,
  type StudioView,
} from '@/agent/components/creative-studio/studio-api'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'

const STUDIO_NAV_ICONS = {
  studio: StudioSvg,
  gallery: GallerySvg,
  video: VideoSvg,
  audio: AudioSvg,
  library: UserSvg,
} satisfies Record<StudioView, typeof StudioSvg>

export const STUDIO_NAV_ITEMS = STUDIO_NAV_DEFINITIONS.map((item) => ({
  ...item,
  Icon: STUDIO_NAV_ICONS[item.id],
}))

export function CreativeStudioShell() {
  const [view, setView] = useState<StudioView>('studio')
  const [config, setConfig] = useState<StudioConfig | null>(null)
  const [activeProject, setActiveProject] = useState<StudioProjectSummary | null>(null)
  const [libraryProject, setLibraryProject] = useState<StudioProjectSummary | null>(null)

  const handleProjectChange = useCallback((project: StudioProjectSummary | null) => {
    setActiveProject(project)
    setLibraryProject((current) => current && current.id !== project?.id ? null : current)
  }, [])

  const handleOpenLibrary = useCallback((project: StudioProjectSummary) => {
    setLibraryProject(project)
  }, [])

  useEffect(() => {
    void fetchStudioConfig()
      .then(setConfig)
      .catch(() => {})
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.classList.add('cs-fullscreen')
    return () => root.classList.remove('cs-fullscreen')
  }, [])

  return (
    <div data-studio-view={view} className="studio-shell flex h-full min-h-0 w-full overflow-hidden text-cream">
      <Toaster position="top-center" toastOptions={{ duration: 3500 }} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-card/85 px-3 pb-2.5 backdrop-blur-md sm:px-4"
          style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href="/agent"
              aria-label="পিছনে — চ্যাট"
              className="alma-frost alma-pod grid h-8 w-8 shrink-0 place-items-center text-cream transition-transform active:scale-95"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <div className="min-w-0">
              <p className="text-lg font-extrabold tracking-tight text-cream">ক্রিয়েটিভ স্টুডিও</p>
              <p className="text-[10px] text-muted">{config?.organization ?? 'ALMA Lifestyle'} · সব ক্রিয়েটিভ এক জায়গায়</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/agent/catalog-images"
              className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-muted hover:text-cream"
            >
              📸 ক্যাটালগ
            </Link>
            {config &&
              (() => {
                const engine = config.singleVtonDefault ?? 'fashn'
                const available = engine !== 'fashn' || config.fashnConfigured
                return (
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                      available ? 'bg-[#81B29A]/15 text-[#2d6a4f]' : 'bg-amber-100 text-amber-800',
                    )}
                  >
                    {available ? `⚙ ${ENGINE_LABELS_BN[engine] ?? engine} চালু` : 'Add FASHN_API_KEY'}
                  </span>
                )
              })()}
          </div>
        </header>

        <ProjectBar onProjectChange={handleProjectChange} onOpenLibrary={handleOpenLibrary} />

        <main className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {view === 'studio' && (
              <motion.div key="studio" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <StudioWorkspaceView config={config} onOpenGallery={() => setView('gallery')} />
              </motion.div>
            )}
            {view === 'gallery' && (
              <motion.div
                key="gallery"
                className="absolute inset-0 overflow-y-auto"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <GalleryView />
              </motion.div>
            )}
            {view === 'video' && (
              <motion.div key="video" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <VideoStudioView onOpenGallery={() => setView('gallery')} onOpenStudio={() => setView('studio')} />
              </motion.div>
            )}
            {view === 'audio' && (
              <motion.div
                key="audio"
                className="absolute inset-0 overflow-y-auto"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <AudioLabView />
              </motion.div>
            )}
            {view === 'library' && (
              <motion.div
                key="library"
                className="absolute inset-0 overflow-y-auto"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <ModelLibraryView />
              </motion.div>
            )}
          </AnimatePresence>
          {libraryProject && (
            <ProjectLibraryView
              key={libraryProject.id}
              project={activeProject?.id === libraryProject.id ? activeProject : libraryProject}
              onClose={() => setLibraryProject(null)}
            />
          )}
        </main>

        <nav
          aria-label="Creative Studio"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="st-tabbar pointer-events-auto flex items-center gap-1 px-2 py-1.5">
            {STUDIO_NAV_ITEMS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => {
                  setLibraryProject(null)
                  setView(id)
                }}
                className={cn(
                  'st-tab flex flex-col items-center gap-0.5 px-3.5 py-1.5 text-[10px] font-semibold',
                  view === id && 'st-tab-on',
                )}
              >
                <Icon className="h-5 w-5" />
                {label}
              </button>
            ))}
          </div>
        </nav>
      </div>
    </div>
  )
}
