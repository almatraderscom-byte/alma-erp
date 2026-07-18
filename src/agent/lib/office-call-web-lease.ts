const LEASE_PREFIX = 'alma_office_call_lease:'
const TAB_ID_KEY = 'alma_office_call_tab_id'
const LEASE_TTL_MS = 15_000
const LEASE_REFRESH_MS = 5_000

export type WebCallLeaseRecord = { owner: string; expiresAt: number }

export function canClaimWebCallLease(existing: WebCallLeaseRecord | null, tabId: string, now: number): boolean {
  return !existing || existing.owner === tabId || existing.expiresAt <= now
}

function parseLease(raw: string | null): WebCallLeaseRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<WebCallLeaseRecord>
    return typeof parsed.owner === 'string' && Number.isFinite(parsed.expiresAt)
      ? { owner: parsed.owner, expiresAt: Number(parsed.expiresAt) }
      : null
  } catch {
    return null
  }
}

function tabId(): string {
  const existing = sessionStorage.getItem(TAB_ID_KEY)
  if (existing) return existing
  const created = crypto.randomUUID()
  sessionStorage.setItem(TAB_ID_KEY, created)
  return created
}

/**
 * Grants one browser tab media ownership for a call. Current Chrome/Edge/Safari
 * use Web Locks. The storage lease is a bounded fallback and self-revokes if a
 * competing tab wins after a race or the owner stops refreshing.
 */
export async function acquireWebCallLease(callId: string, onLost: () => void): Promise<(() => void) | null> {
  const lockManager = navigator.locks
  if (lockManager?.request) {
    let releaseHold: (() => void) | null = null
    const hold = new Promise<void>((resolve) => { releaseHold = resolve })
    try {
      return await new Promise<(() => void) | null>((resolve, reject) => {
        void lockManager.request(`alma-office-call:${callId}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve(null)
            return
          }
          let released = false
          resolve(() => {
            if (released) return
            released = true
            releaseHold?.()
          })
          await hold
        }).catch(reject)
      })
    } catch {
      // A partially implemented Web Locks API must not disable calling. Fall
      // through to the bounded storage lease instead.
    }
  }

  const owner = tabId()
  const key = `${LEASE_PREFIX}${callId}`
  const now = Date.now()
  if (!canClaimWebCallLease(parseLease(localStorage.getItem(key)), owner, now)) return null
  localStorage.setItem(key, JSON.stringify({ owner, expiresAt: now + LEASE_TTL_MS }))
  if (parseLease(localStorage.getItem(key))?.owner !== owner) return null

  let released = false
  const lose = () => {
    if (released) return
    released = true
    clearInterval(refresh)
    window.removeEventListener('storage', onStorage)
    onLost()
  }
  const refresh = setInterval(() => {
    const current = parseLease(localStorage.getItem(key))
    if (current?.owner !== owner) {
      lose()
      return
    }
    localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + LEASE_TTL_MS }))
  }, LEASE_REFRESH_MS)
  const onStorage = (event: StorageEvent) => {
    if (event.key === key && parseLease(event.newValue)?.owner !== owner) lose()
  }
  window.addEventListener('storage', onStorage)

  return () => {
    if (released) return
    released = true
    clearInterval(refresh)
    window.removeEventListener('storage', onStorage)
    if (parseLease(localStorage.getItem(key))?.owner === owner) localStorage.removeItem(key)
  }
}
