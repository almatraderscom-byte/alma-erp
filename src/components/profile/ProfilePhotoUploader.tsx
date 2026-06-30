'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { captureProfileFromFile, type ProfileCaptureResult } from '@/lib/profile-image-client'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { Button } from '@/components/ui'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { cn } from '@/lib/utils'

type Props = {
  userId: string
  name: string
  email?: string | null
  imageUrl?: string | null
  imageVersion?: Date | string | null
  canEdit?: boolean
  uploadPath?: string
  onUpdated?: (payload: { imageUrl: string; updatedAt: string }) => void
  size?: 'md' | 'lg' | 'xl' | '2xl'
  variant?: 'default' | 'hero'
}

export function ProfilePhotoUploader({
  userId,
  name,
  email,
  imageUrl,
  imageVersion,
  canEdit = true,
  uploadPath,
  onUpdated,
  size = 'xl',
  variant = 'default',
}: Props) {
  const endpoint = uploadPath || '/api/users/me/profile-image'
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const cameraInputId = useId()
  const galleryInputId = useId()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [preview, setPreview] = useState<ProfileCaptureResult | null>(null)
  const [version, setVersion] = useState(imageVersion)
  const [localUrl, setLocalUrl] = useState<string | null>(imageUrl ?? null)
  const [dragOver, setDragOver] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)

  useEffect(() => {
    setLocalUrl(imageUrl ?? null)
    setVersion(imageVersion)
  }, [imageUrl, imageVersion])

  const displayUrl = preview?.imageDataUrl ?? localUrl ?? null
  const avatarSize = variant === 'hero' ? '2xl' : size

  const upload = useCallback(
    async (file: File) => {
      setBusy(true)
      setProgress(10)
      try {
        const processed = await captureProfileFromFile(file)
        setPreview(processed)
        setProgress(40)
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_data_url: processed.imageDataUrl,
            thumb_data_url: processed.thumbDataUrl,
          }),
        })
        setProgress(85)
        const j = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(j.error || 'Upload failed')
        const nextUrl = String(j.profileImageUrl || `/api/users/${userId}/profile-image`)
        const nextVersion = String(j.updatedAt || new Date().toISOString())
        setVersion(nextVersion)
        setLocalUrl(nextUrl)
        setPreview(null)
        setAvatarKey(k => k + 1)
        setProgress(100)
        toast.success('Profile photo saved')
        onUpdated?.({ imageUrl: nextUrl, updatedAt: nextVersion })
        window.dispatchEvent(
          new CustomEvent('alma:profile-updated', {
            detail: { userId, profileImageUrl: nextUrl, updatedAt: nextVersion },
          }),
        )
      } catch (e) {
        toast.error((e as Error).message || 'Upload failed — try again')
        setPreview(null)
      } finally {
        setBusy(false)
        setTimeout(() => setProgress(0), 400)
      }
    },
    [endpoint, onUpdated, userId],
  )

  async function removePhoto() {
    if (!(await confirmDialog({ message: 'Remove your profile photo?', danger: true, confirmLabel: 'Remove' }))) return
    setBusy(true)
    try {
      const res = await fetch(endpoint, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Could not remove photo')
      setPreview(null)
      setLocalUrl(null)
      setVersion(null)
      setAvatarKey(k => k + 1)
      toast.success('Profile photo removed')
      onUpdated?.({ imageUrl: '', updatedAt: new Date().toISOString() })
      window.dispatchEvent(
        new CustomEvent('alma:profile-updated', {
          detail: { userId, profileImageUrl: null },
        }),
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function onFile(file: File | undefined) {
    if (!file || !canEdit || busy) return
    void upload(file)
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-4',
        variant === 'hero' && 'w-full',
      )}
    >
      <div
        className={cn(
          'relative rounded-full',
          dragOver && 'ring-2 ring-gold/50 ring-offset-4 ring-offset-[#0b0b0f]',
          variant === 'hero' && 'mx-auto',
        )}
        onDragOver={e => {
          if (!canEdit) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          if (!canEdit) return
          e.preventDefault()
          setDragOver(false)
          onFile(e.dataTransfer.files?.[0])
        }}
      >
        <EmployeeAvatar
          key={avatarKey}
          userId={userId}
          name={name}
          email={email}
          imageUrl={displayUrl}
          imageVersion={version}
          size={avatarSize}
          showStatus={variant === 'hero'}
          className={variant === 'hero' ? 'shadow-lg shadow-gold/20' : undefined}
        />
        {canEdit && (
          <button
            type="button"
            className={cn(
              'absolute bottom-0 right-0 flex items-center justify-center rounded-full border border-gold-dim/50 bg-gold text-black shadow-lg transition active:scale-95',
              variant === 'hero' ? 'h-11 w-11 text-lg' : 'h-8 w-8',
            )}
            disabled={busy}
            onClick={() => cameraInputRef.current?.click()}
            aria-label="Change profile photo"
          >
            📷
          </button>
        )}
      </div>

      <input
        id={cameraInputId}
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="user"
        className="sr-only"
        disabled={!canEdit || busy}
        onChange={e => {
          onFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <input
        id={galleryInputId}
        ref={galleryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
        className="sr-only"
        disabled={!canEdit || busy}
        onChange={e => {
          onFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {canEdit && (
        <div className={cn('flex w-full flex-col gap-3', variant === 'hero' ? 'max-w-md' : 'max-w-xs')}>
          <div className={cn('grid gap-2', variant === 'hero' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2')}>
            <Button
              variant="gold"
              size={variant === 'hero' ? 'sm' : 'xs'}
              className="w-full justify-center min-h-[44px] touch-manipulation"
              disabled={busy}
              onClick={() => cameraInputRef.current?.click()}
            >
              {busy ? 'Saving…' : '📷 Take photo'}
            </Button>
            <Button
              variant="secondary"
              size={variant === 'hero' ? 'sm' : 'xs'}
              className="w-full justify-center min-h-[44px] touch-manipulation"
              disabled={busy}
              onClick={() => galleryInputRef.current?.click()}
            >
              🖼 Choose from gallery
            </Button>
          </div>
          {displayUrl && (
            <Button
              variant="ghost"
              size="xs"
              className="w-full justify-center min-h-[40px] touch-manipulation text-muted"
              disabled={busy}
              onClick={() => void removePhoto()}
            >
              Remove photo
            </Button>
          )}
          <p className="text-center text-[10px] leading-relaxed text-muted">
            Square crop · auto-compressed · JPG, PNG, WEBP, HEIC · max 8 MB
          </p>
          {progress > 0 && (
            <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-gold transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
