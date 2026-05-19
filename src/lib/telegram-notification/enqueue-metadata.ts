import type { QueueRowMeta } from '@/lib/telegram-notification/deliver'

/** Attach ERP user identity for Telegram photo delivery (thumb or initials). */
export function withEmployeeAvatarMetadata(
  metadata: QueueRowMeta,
  userId: string | null | undefined,
  employeeName?: string | null,
): QueueRowMeta {
  if (!userId) return metadata
  return {
    ...metadata,
    userId,
    employeeName: employeeName || metadata.employeeName,
    deliveryMode: metadata.deliveryMode === 'photo' || metadata.deliveryMode === 'face_photo'
      ? metadata.deliveryMode
      : metadata.deliveryMode || 'profile_avatar',
  }
}
