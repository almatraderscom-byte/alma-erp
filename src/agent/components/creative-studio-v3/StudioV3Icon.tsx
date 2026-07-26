import type { ReactNode, SVGProps } from 'react'

export type StudioV3IconName =
  | 'home'
  | 'image'
  | 'video'
  | 'gallery'
  | 'finish'
  | 'project'
  | 'systems'
  | 'review'
  | 'operations'
  | 'voice'
  | 'audio'
  | 'campaign'
  | 'search'
  | 'arrow'
  | 'lock'
  | 'spark'
  | 'grid'
  | 'list'
  | 'filter'
  | 'refresh'
  | 'close'
  | 'check'
  | 'warning'
  | 'archive'
  | 'more'
  | 'account'

const paths: Record<StudioV3IconName, ReactNode> = {
  home: <><path d="m3.5 10.5 8.5-7 8.5 7" /><path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5 18 4.5-4.5 3 3 2-2 4.5 3.5" /></>,
  video: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></>,
  gallery: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  finish: <><path d="M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-2.2a2 2 0 0 1-2-2V5.2A2.2 2.2 0 0 0 12 3Z" /><circle cx="7.5" cy="11.5" r="1" /><circle cx="10" cy="7.5" r="1" /><circle cx="8.5" cy="16" r="1" /></>,
  project: <><path d="M3 7.5h7l2-2h9v14H3Z" /><path d="M3 10h18" /></>,
  systems: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></>,
  review: <><path d="M7 3h10v3h3v15H4V6h3Z" /><path d="m8 13 2.5 2.5L16 10" /></>,
  operations: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
  voice: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" /></>,
  audio: <><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>,
  campaign: <><path d="m4 13 2 7h3l-1-7" /><path d="M5 7v6l12 4V3Z" /><path d="M19 8.5h2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  arrow: <path d="m9 18 6-6-6-6" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  spark: <><path d="m12 2 1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6Z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
  list: <><path d="M9 6h12M9 12h12M9 18h12" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8Z" />,
  refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 0-2 5" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12 4 4L19 6" />,
  warning: <><path d="M12 3 2.5 20h19Z" /><path d="M12 9v4m0 3h.01" /></>,
  archive: <><rect x="3" y="5" width="18" height="4" rx="1" /><path d="M5 9v11h14V9M9 13h6" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  account: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
}

export function StudioV3Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: StudioV3IconName }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      {...props}
    >
      {paths[name]}
    </svg>
  )
}
