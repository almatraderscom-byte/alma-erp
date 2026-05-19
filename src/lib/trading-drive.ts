import { serverPost } from '@/lib/server-api'

export type TradingDriveUploadResult = {
  ok: boolean
  drive_file_id: string
  drive_folder_id?: string
  preview_url?: string
  file_name?: string
  size_bytes?: number
}

export type TradingDriveFetchResult = {
  ok: boolean
  file_name: string
  mime_type: string
  base64: string
}

export async function uploadTradingScreenshotToDrive(input: {
  accountId: string
  accountName: string
  employeeId?: string | null
  uploadDate: string
  fileName: string
  mimeType: string
  base64: string
}) {
  return serverPost<TradingDriveUploadResult>('trading_upload_screenshot', {
    account_id: input.accountId,
    account_name: input.accountName,
    employee_id: input.employeeId || '',
    upload_date: input.uploadDate,
    file_name: input.fileName,
    mime_type: input.mimeType,
    data: input.base64,
  }, { timeoutMs: 90_000 })
}

export async function fetchTradingScreenshotFromDrive(driveFileId: string) {
  return serverPost<TradingDriveFetchResult>('trading_get_screenshot', {
    drive_file_id: driveFileId,
  }, { timeoutMs: 45_000 })
}

export async function deleteTradingScreenshotsFromDrive(driveFileIds: string[]) {
  if (!driveFileIds.length) return { ok: true, deleted: 0, missing: 0 }
  return serverPost<{ ok: boolean; deleted: number; missing: number; errors?: string[] }>('trading_delete_screenshots', {
    drive_file_ids: driveFileIds,
  }, { timeoutMs: 90_000 })
}
