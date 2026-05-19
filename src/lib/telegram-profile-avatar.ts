import { fetchProfileImageBuffer } from '@/lib/profile-image'
import { prisma } from '@/lib/prisma'
import { initialsFor } from '@/lib/user-display'
import { storageReadiness } from '@/lib/supabase-storage'

export type TelegramAvatarPayload = {
  buffer: Buffer
  contentType: string
  fileName: string
}

/** Lightweight thumb for Telegram (storage) or generated initials tile. */
export async function loadTelegramProfileAvatar(
  userId: string,
  displayName?: string | null,
): Promise<TelegramAvatarPayload | null> {
  if (!userId) return null

  if (storageReadiness().configured) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { profileImageUrl: true },
      })
      if (user?.profileImageUrl) {
        const thumb = await fetchProfileImageBuffer(userId, 'thumb')
        if (thumb?.buffer?.length) {
          return {
            buffer: thumb.buffer,
            contentType: thumb.contentType || 'image/webp',
            fileName: 'profile-thumb.webp',
          }
        }
      }
    } catch {
      /* fall through to initials */
    }
  }

  return generateInitialsAvatarBuffer(initialsFor(displayName))
}

async function generateInitialsAvatarBuffer(initials: string): Promise<TelegramAvatarPayload> {
  const sharp = (await import('sharp')).default
  const label = initials.slice(0, 2) || '?'
  const svg = `
    <svg width="96" height="96" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#1a1814"/>
          <stop offset="100%" stop-color="#0b0b0f"/>
        </linearGradient>
      </defs>
      <rect width="96" height="96" fill="url(#g)"/>
      <circle cx="48" cy="48" r="44" fill="none" stroke="#d6a94a" stroke-width="2" opacity="0.45"/>
      <text x="48" y="54" text-anchor="middle" font-family="system-ui, sans-serif" font-size="32" font-weight="700" fill="#e8c878">${label}</text>
    </svg>`
  const buffer = await sharp(Buffer.from(svg)).webp({ quality: 72 }).toBuffer()
  return { buffer, contentType: 'image/webp', fileName: 'initials.webp' }
}
