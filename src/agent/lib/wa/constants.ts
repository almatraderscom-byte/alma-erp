/** WhatsApp Cloud API — pageId prefix for CsConversation reuse (pageId_psid unique). */
export const WA_PAGE_PREFIX = 'wa:'

export function waPageId(phoneNumberId?: string | null): string {
  const id = phoneNumberId ?? process.env.WA_PHONE_ID ?? ''
  return `${WA_PAGE_PREFIX}${id}`
}

export function isWaPageId(pageId: string): boolean {
  return pageId.startsWith(WA_PAGE_PREFIX)
}

export function waPhoneNumberIdFromPage(pageId: string): string {
  return pageId.slice(WA_PAGE_PREFIX.length)
}
