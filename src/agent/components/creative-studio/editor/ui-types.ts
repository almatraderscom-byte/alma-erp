import type { EditorPendingAction } from '@/lib/creative-studio/editor-agent'

export type EditorTool =
  | 'project'
  | 'media'
  | 'library'
  | 'video'
  | 'image'
  | 'caption'
  | 'voice'
  | 'music'
  | 'sfx'

export type EditorSelection = {
  trackId: string
  clipId: string
}

export type EditorWorkbenchTab = 'inspector' | 'agent' | 'review' | 'activity'

export type EditorFocusMode = 'stage' | 'timeline' | 'media' | 'workbench'

export type PendingActionRequestHandler = (action: EditorPendingAction) => void
