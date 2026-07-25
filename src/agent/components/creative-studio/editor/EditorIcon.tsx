import type { ReactNode, SVGProps } from 'react'

export type EditorIconName =
  | 'activity'
  | 'agent'
  | 'arrow-left'
  | 'assets'
  | 'caption'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'folder'
  | 'image'
  | 'inspector'
  | 'layers'
  | 'library'
  | 'lock'
  | 'music'
  | 'pause'
  | 'play'
  | 'project'
  | 'redo'
  | 'review'
  | 'safe-zone'
  | 'scissors'
  | 'search'
  | 'sfx'
  | 'timeline'
  | 'undo'
  | 'video'
  | 'voice'
  | 'volume'
  | 'warning'
  | 'zoom-in'
  | 'zoom-out'

const paths: Record<EditorIconName, ReactNode> = {
  activity: <><path d="M4 12h3l2-5 4 10 2-5h5" /><path d="M3 4v16h18" /></>,
  agent: <><path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z" /><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /></>,
  'arrow-left': <><path d="m15 18-6-6 6-6" /><path d="M9 12h10" /></>,
  assets: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m3 15 5-5 4 4 2-2 7 6" /><circle cx="16.5" cy="8.5" r="1.5" /></>,
  caption: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 10h4M7 14h7M16 10h1" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  'chevron-down': <path d="m7 9 5 5 5-5" />,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  folder: <path d="M3 7h7l2 2h9v10H3V7Z" />,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m4 17 5-5 3 3 2-2 6 5" /></>,
  inspector: <><path d="M4 5h16M4 12h16M4 19h16" /><circle cx="9" cy="5" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="19" r="2" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  library: <><path d="M5 4h4v16H5zM10 4h4v16h-4zM15 5l4-1 3 15-4 1-3-15Z" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" /></>,
  music: <><path d="M9 18V6l10-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></>,
  pause: <><path d="M9 5v14M15 5v14" /></>,
  play: <path d="m8 5 11 7-11 7V5Z" />,
  project: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  redo: <><path d="M20 7v5h-5" /><path d="M4 17a8 8 0 0 1 13.5-6L20 12" /></>,
  review: <><path d="M4 5h16v11H8l-4 4V5Z" /><path d="m8 10 2 2 5-5" /></>,
  'safe-zone': <><rect x="3" y="3" width="18" height="18" rx="2" /><rect x="6" y="6" width="12" height="12" rx="1" strokeDasharray="2 2" /></>,
  scissors: <><circle cx="6" cy="7" r="3" /><circle cx="6" cy="17" r="3" /><path d="m8.5 8.5 11 8.5M8.5 15.5 19.5 7" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  sfx: <><path d="M5 14h3l4 4V6L8 10H5v4Z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></>,
  timeline: <><path d="M4 7h16M4 12h16M4 17h16" /><path d="M9 4v16" /></>,
  undo: <><path d="M4 7v5h5" /><path d="M20 17a8 8 0 0 0-13.5-6L4 12" /></>,
  video: <><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-2v8l-4-2" /></>,
  voice: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></>,
  volume: <><path d="M4 14h4l5 4V6L8 10H4v4Z" /><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11" /></>,
  warning: <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17h.01" /></>,
  'zoom-in': <><circle cx="10" cy="10" r="6" /><path d="M10 7v6M7 10h6M15 15l6 6" /></>,
  'zoom-out': <><circle cx="10" cy="10" r="6" /><path d="M7 10h6M15 15l6 6" /></>,
}

export function EditorIcon({
  name,
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & { name: EditorIconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {paths[name]}
    </svg>
  )
}
