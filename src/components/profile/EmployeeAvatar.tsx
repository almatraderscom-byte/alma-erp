'use client'

import { useEffect, useMemo, useState } from 'react'
import { initialsFor, userAvatarUrl } from '@/lib/user-display'
import { cn } from '@/lib/utils'

const SIZES = {
  xs: 'h-7 w-7 text-[9px]',
  sm: 'h-9 w-9 text-[10px]',
  md: 'h-11 w-11 text-[11px]',
  lg: 'h-14 w-14 text-xs',
  xl: 'h-20 w-20 text-sm',
  '2xl': 'h-28 w-28 text-base sm:h-32 sm:w-32',
} as const

type Props = {
  userId?: string | null
  name?: string | null
  email?: string | null
  imageUrl?: string | null
  imageVersion?: Date | string | null
  size?: keyof typeof SIZES
  className?: string
  showStatus?: boolean
}

/** Append ?v= for same-origin profile API URLs (cache bust after upload). */
function withCacheBust(src: string, imageVersion?: Date | string | null): string {
  if (src.startsWith('data:') || /^https?:\/\//i.test(src)) return src
  if (!src.includes('/profile-image')) return src
  if (/[?&]v=\d+/.test(src)) return src
  const stamp = imageVersion ? new Date(imageVersion).getTime() : ''
  if (!stamp) return src
  const join = src.includes('?') ? '&' : '?'
  return `${src}${join}v=${stamp}`
}

export function EmployeeAvatar({
  userId,
  name,
  email,
  imageUrl,
  imageVersion,
  size = 'md',
  className,
  showStatus,
}: Props) {
  const initials = initialsFor(name || email)
  const src = useMemo(() => {
    // Inline previews (upload capture) and external avatars are used verbatim.
    if (imageUrl && /^(data:|blob:|https?:\/\/)/i.test(imageUrl)) return imageUrl
    // Canonical source: the profile-image API keyed by userId. Resolving every
    // avatar that has a userId through this endpoint makes the photo render
    // consistently everywhere, regardless of the raw profileImageUrl shape a
    // given loader happened to pass in (some pass the API path, some pass an
    // unloadable storage path, some pass nothing — which caused the same staff
    // to show a photo on one screen and a placeholder on another).
    if (userId) return userAvatarUrl(userId, imageVersion)
    // No userId: fall back to a relative API path if one was supplied.
    if (imageUrl) return withCacheBust(imageUrl, imageVersion)
    return null
  }, [imageUrl, imageVersion, userId])

  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src, userId, imageVersion])

  const showPhoto = Boolean(src) && !failed

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-gold-dim/35 bg-gradient-to-br from-gold/20 to-zinc-900 font-black text-gold-lt shadow-inner [&>img]:rounded-full',
        SIZES[size],
        className,
      )}
    >
      {showPhoto ? (
        // Native img: auth cookies reach /api/users/.../profile-image (next/image optimizer cannot).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src!}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden>{initials}</span>
      )}
      {showStatus && (
        <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[#0b0b0f] bg-green-400" />
      )}
    </span>
  )
}
