export interface ContractToolRecord {
  toolName: string
  status: 'success' | 'error'
  error: string | null
}

/** A required tool failure is terminal for this owner turn. */
export function findContractToolFailure<T extends ContractToolRecord>(
  requiredTool: string | null | undefined,
  records: readonly T[],
): T | undefined {
  if (!requiredTool) return undefined
  return records.find((record) => record.toolName === requiredTool && record.status === 'error')
}

export function contractToolFailureText(record: ContractToolRecord): string {
  return (
    `⚠️ বাধ্যতামূলক ধাপ ${record.toolName} সফল হয়নি, তাই কাজ সম্পন্ন বলছি না। ` +
    `কারণ: ${record.error ?? 'unknown error'}`
  )
}
