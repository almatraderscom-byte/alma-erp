/** In-memory staging for full-quality face photos during same-request Telegram delivery. */

const liveFacePhotoByRecordId = new Map<string, { buffer: Buffer; contentType: string }>()

export function stageLiveFacePhotoForTelegram(attendanceRecordId: string, buffer: Buffer, contentType: string) {
  liveFacePhotoByRecordId.set(attendanceRecordId, { buffer, contentType })
}

export function clearLiveFacePhotoForTelegram(attendanceRecordId: string) {
  liveFacePhotoByRecordId.delete(attendanceRecordId)
}

export function consumeLiveFacePhoto(attendanceRecordId: string) {
  const row = liveFacePhotoByRecordId.get(attendanceRecordId)
  if (row) liveFacePhotoByRecordId.delete(attendanceRecordId)
  return row
}
