import type { SVGProps } from 'react'

export type StudioIconName =
  | 'activity'
  | 'agent'
  | 'analytics'
  | 'archive'
  | 'arrow-left'
  | 'assets'
  | 'audio'
  | 'caption'
  | 'campaign'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'clock'
  | 'close'
  | 'download'
  | 'folder'
  | 'grid'
  | 'grid-compact'
  | 'grid-large'
  | 'home'
  | 'history'
  | 'image'
  | 'inspector'
  | 'layers'
  | 'library'
  | 'list'
  | 'lock'
  | 'more'
  | 'palette'
  | 'pause'
  | 'play'
  | 'plus'
  | 'projects'
  | 'publish'
  | 'refresh'
  | 'redo'
  | 'review'
  | 'search'
  | 'scissors'
  | 'sliders'
  | 'share'
  | 'skip-back'
  | 'template'
  | 'undo'
  | 'video'
  | 'voice'
  | 'wallet'
  | 'worker'

type StudioV2IconProps = SVGProps<SVGSVGElement> & {
  name: StudioIconName
  size?: number
}

export function StudioV2Icon({
  name,
  size = 20,
  ...props
}: StudioV2IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {name === 'home' && (
          <>
            <path d="m3 10 9-7 9 7" />
            <path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7" />
          </>
        )}
        {name === 'projects' && (
          <>
            <rect height="7" rx="2" width="8" x="3" y="4" />
            <rect height="7" rx="2" width="8" x="13" y="4" />
            <rect height="7" rx="2" width="8" x="3" y="14" />
            <rect height="7" rx="2" width="8" x="13" y="14" />
          </>
        )}
        {name === 'assets' && (
          <>
            <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5L12 6h6.5A1.5 1.5 0 0 1 20 7.5v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
            <path d="m7 16 3-3 2.2 2.2L15 12l3 4" />
          </>
        )}
        {name === 'template' && (
          <>
            <rect height="16" rx="2" width="16" x="4" y="4" />
            <path d="M4 9h16M10 9v11" />
          </>
        )}
        {name === 'review' && (
          <>
            <path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5v13h13A1.5 1.5 0 0 0 18.5 18v-2.5" />
            <path d="m9 14 2-4 7.5-7.5a1.4 1.4 0 0 1 2 2L13 12Z" />
            <path d="m16.5 4.5 3 3" />
          </>
        )}
        {name === 'activity' && (
          <path d="M3 12h4l2-6 4 12 2-6h6" />
        )}
        {name === 'search' && (
          <>
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 5 5" />
          </>
        )}
        {name === 'agent' && (
          <>
            <path d="m12 2 1.5 5.2L19 9l-5.5 1.8L12 16l-1.5-5.2L5 9l5.5-1.8Z" />
            <path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z" />
          </>
        )}
        {name === 'image' && (
          <>
            <rect height="16" rx="2.5" width="18" x="3" y="4" />
            <circle cx="9" cy="9" r="1.5" />
            <path d="m5.5 17 4-4 2.5 2.5 2.5-3 4 4.5" />
          </>
        )}
        {name === 'video' && (
          <>
            <rect height="14" rx="2.5" width="14" x="3" y="5" />
            <path d="m17 10 4-2v8l-4-2Z" />
          </>
        )}
        {name === 'voice' && (
          <>
            <rect height="11" rx="4" width="7" x="8.5" y="3" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
          </>
        )}
        {name === 'audio' && (
          <>
            <path d="M9 18V5l10-2v13" />
            <ellipse cx="6" cy="18" rx="3" ry="2.2" />
            <ellipse cx="16" cy="16" rx="3" ry="2.2" />
          </>
        )}
        {name === 'campaign' && (
          <>
            <path d="M4 5h11l5 5-5 5H4Z" />
            <path d="M4 15v4h11M8 5v10" />
          </>
        )}
        {name === 'layers' && (
          <>
            <path d="m12 3 9 5-9 5-9-5Z" />
            <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
          </>
        )}
        {name === 'library' && (
          <>
            <path d="M4 4h4v16H4zM10 4h4v16h-4zM16 5l3.5-1 3.5 15-3.5 1z" />
          </>
        )}
        {name === 'analytics' && (
          <>
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
            <path d="m3 8 6-4 6 6 6-5" />
          </>
        )}
        {name === 'archive' && (
          <>
            <path d="M4 8h16v12H4zM3 4h18v4H3z" />
            <path d="M9 12h6" />
          </>
        )}
        {name === 'worker' && (
          <>
            <rect height="14" rx="3" width="18" x="3" y="6" />
            <path d="M8 3v3M16 3v3M8 13h.01M12 13h.01M16 13h.01M8 17h8" />
          </>
        )}
        {name === 'wallet' && (
          <>
            <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19v16H6a2 2 0 0 1-2-2Z" />
            <path d="M4 8h15M15 12h6v4h-6a2 2 0 0 1 0-4Z" />
          </>
        )}
        {name === 'publish' && (
          <>
            <path d="M12 16V3M7 8l5-5 5 5" />
            <path d="M5 13v7h14v-7" />
          </>
        )}
        {name === 'lock' && (
          <>
            <rect height="10" rx="2" width="14" x="5" y="11" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </>
        )}
        {name === 'check' && <path d="m4 12 5 5L20 6" />}
        {name === 'clock' && (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </>
        )}
        {name === 'folder' && (
          <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />
        )}
        {name === 'grid-large' && (
          <>
            <rect height="7" rx="1.5" width="7" x="3" y="3" />
            <rect height="7" rx="1.5" width="7" x="14" y="3" />
            <rect height="7" rx="1.5" width="7" x="3" y="14" />
            <rect height="7" rx="1.5" width="7" x="14" y="14" />
          </>
        )}
        {name === 'grid' && (
          <>
            <rect height="5.5" rx="1.2" width="5.5" x="3" y="3" />
            <rect height="5.5" rx="1.2" width="5.5" x="9.25" y="3" />
            <rect height="5.5" rx="1.2" width="5.5" x="15.5" y="3" />
            <rect height="5.5" rx="1.2" width="5.5" x="3" y="9.25" />
            <rect height="5.5" rx="1.2" width="5.5" x="9.25" y="9.25" />
            <rect height="5.5" rx="1.2" width="5.5" x="15.5" y="9.25" />
            <rect height="5.5" rx="1.2" width="5.5" x="3" y="15.5" />
            <rect height="5.5" rx="1.2" width="5.5" x="9.25" y="15.5" />
            <rect height="5.5" rx="1.2" width="5.5" x="15.5" y="15.5" />
          </>
        )}
        {name === 'grid-compact' && (
          <>
            {[3, 8.5, 14, 19.5].flatMap((x) =>
              [3, 8.5, 14, 19.5].map((y) => (
                <rect height="3.5" key={`${x}-${y}`} rx=".7" width="3.5" x={x - 1.5} y={y - 1.5} />
              )),
            )}
          </>
        )}
        {name === 'list' && (
          <>
            <path d="M9 6h12M9 12h12M9 18h12" />
            <rect height="3" rx=".6" width="3" x="3" y="4.5" />
            <rect height="3" rx=".6" width="3" x="3" y="10.5" />
            <rect height="3" rx=".6" width="3" x="3" y="16.5" />
          </>
        )}
        {name === 'history' && (
          <>
            <path d="M4 7V3m0 4h4" />
            <path d="M4.8 7A8.5 8.5 0 1 1 3.5 14" />
            <path d="M12 7v5l3.5 2" />
          </>
        )}
        {name === 'refresh' && (
          <>
            <path d="M20 6v5h-5" />
            <path d="M4 18v-5h5" />
            <path d="M6.1 9A7 7 0 0 1 18.4 6.8L20 11M4 13l1.6 4.2A7 7 0 0 0 17.9 15" />
          </>
        )}
        {name === 'sliders' && (
          <>
            <path d="M4 6h16M4 12h16M4 18h16" />
            <circle cx="9" cy="6" r="2" fill="var(--bg-1)" />
            <circle cx="15" cy="12" r="2" fill="var(--bg-1)" />
            <circle cx="7" cy="18" r="2" fill="var(--bg-1)" />
          </>
        )}
        {name === 'palette' && (
          <>
            <path d="M12 3a9 9 0 1 0 0 18h1.4a2 2 0 0 0 1.4-3.4l-.3-.3a2 2 0 0 1 1.4-3.4H18a3 3 0 0 0 3-3A8 8 0 0 0 12 3Z" />
            <circle cx="7.5" cy="10" r=".8" fill="currentColor" stroke="none" />
            <circle cx="10" cy="6.8" r=".8" fill="currentColor" stroke="none" />
            <circle cx="14" cy="6.8" r=".8" fill="currentColor" stroke="none" />
          </>
        )}
        {name === 'plus' && <path d="M12 5v14M5 12h14" />}
        {name === 'chevron-right' && <path d="m9 5 7 7-7 7" />}
        {name === 'chevron-down' && <path d="m5 9 7 7 7-7" />}
        {name === 'arrow-left' && (
          <>
            <path d="m10 5-7 7 7 7M3 12h18" />
          </>
        )}
        {name === 'play' && <path d="m8 5 11 7-11 7Z" />}
        {name === 'pause' && (
          <>
            <path d="M9 5v14M15 5v14" />
          </>
        )}
        {name === 'skip-back' && (
          <>
            <path d="M6 5v14M19 6l-9 6 9 6Z" />
          </>
        )}
        {name === 'scissors' && (
          <>
            <circle cx="6" cy="7" r="3" />
            <circle cx="6" cy="17" r="3" />
            <path d="m8.5 8.5 12 7M8.5 15.5 20.5 8" />
          </>
        )}
        {name === 'undo' && (
          <>
            <path d="M9 8H4V3" />
            <path d="M4 8a9 9 0 1 1 2 9" />
          </>
        )}
        {name === 'redo' && (
          <>
            <path d="M15 8h5V3" />
            <path d="M20 8a9 9 0 1 0-2 9" />
          </>
        )}
        {name === 'share' && (
          <>
            <circle cx="18" cy="5" r="2.5" />
            <circle cx="6" cy="12" r="2.5" />
            <circle cx="18" cy="19" r="2.5" />
            <path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5" />
          </>
        )}
        {name === 'download' && (
          <>
            <path d="M12 3v12M7 11l5 5 5-5M5 21h14" />
          </>
        )}
        {name === 'caption' && (
          <>
            <rect height="14" rx="2.5" width="18" x="3" y="5" />
            <path d="M7 14h4M13 14h4M7 10h10" />
          </>
        )}
        {name === 'inspector' && (
          <>
            <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
            <circle cx="16" cy="6" r="2" />
            <circle cx="8" cy="12" r="2" />
            <circle cx="14" cy="18" r="2" />
          </>
        )}
        {name === 'more' && (
          <>
            <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
            <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
          </>
        )}
        {name === 'close' && <path d="m6 6 12 12M18 6 6 18" />}
      </g>
    </svg>
  )
}
