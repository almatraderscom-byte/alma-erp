/** Shared display helpers for employee/user identity in UI. */

export function initialsFor(nameOrEmail: string | null | undefined): string {
  const base = nameOrEmail?.trim() || '?'
  if (base.includes('@')) return base.slice(0, 2).toUpperCase()
  const parts = base.split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

export function userAvatarUrl(userId: string | null | undefined, updatedAt?: Date | string | null): string | null {
  if (!userId) return null
  const v = updatedAt ? new Date(updatedAt).getTime() : ''
  return `/api/users/${encodeURIComponent(userId)}/profile-image${v ? `?v=${v}` : ''}`
}

export function resolveProfileImageForUser(user: {
  id: string
  profileImageUrl?: string | null
  updatedAt?: Date | string | null
}): string | null {
  if (!user.profileImageUrl) return null
  if (/^https?:\/\//i.test(user.profileImageUrl)) return user.profileImageUrl
  if (user.profileImageUrl.includes('/profile-image')) {
    return userAvatarUrl(user.id, user.updatedAt)
  }
  return user.profileImageUrl
}
