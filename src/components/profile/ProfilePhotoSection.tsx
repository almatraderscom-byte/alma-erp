'use client'

import Link from 'next/link'
import { ProfilePhotoUploader } from '@/components/profile/ProfilePhotoUploader'

type Props = {
  userId: string
  name: string
  email?: string | null
  imageUrl?: string | null
  uploadPath?: string
  canEdit?: boolean
  showSettingsLink?: boolean
  onUpdated?: (payload: { imageUrl: string; updatedAt: string }) => void
}

/** Highly visible profile photo block for employee-facing pages. */
export function ProfilePhotoSection({
  userId,
  name,
  email,
  imageUrl,
  uploadPath,
  canEdit = true,
  showSettingsLink = true,
  onUpdated,
}: Props) {
  return (
    <section
      id="profile-photo"
      className="scroll-mt-24 rounded-2xl border border-gold-dim/35 bg-gradient-to-br from-gold/[0.06] via-card to-card p-5 sm:p-6 shadow-[0_0_40px_rgba(224,122,95,0.08)]"
    >
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">Your profile photo</p>
          <p className="mt-1 text-sm text-zinc-400">
            Shown on attendance, approvals, trading, and team views. Tap the camera to update anytime.
          </p>
        </div>
        {showSettingsLink ? (
          <Link
            href="/settings/session#profile-photo"
            className="mt-2 text-[11px] font-semibold text-gold-lt underline-offset-2 hover:underline sm:mt-0"
          >
            Account settings →
          </Link>
        ) : (
          <Link
            href="/portal#profile-photo"
            className="mt-2 text-[11px] font-semibold text-gold-lt underline-offset-2 hover:underline sm:mt-0"
          >
            My portal →
          </Link>
        )}
      </div>
      <ProfilePhotoUploader
        userId={userId}
        name={name}
        email={email}
        imageUrl={imageUrl}
        uploadPath={uploadPath}
        canEdit={canEdit}
        variant="hero"
        onUpdated={onUpdated}
      />
    </section>
  )
}
