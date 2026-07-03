/**
 * Home-screen quick actions (long-press the app icon) for the native shell.
 *
 * Static shortcuts that deep-link into existing ERP routes. Purely additive and
 * fail-open: any plugin error is swallowed so it can never affect app startup.
 * The shell loads the live site, so a shortcut tap just navigates the WebView to
 * the same-origin route (kept in-shell by capacitor.config allowNavigation).
 */
import { AppShortcuts } from '@capawesome/capacitor-app-shortcuts'
import { isCapacitorNative } from '@/lib/capacitor-native'

type QuickAction = { id: string; title: string; description: string; iosIcon: string; path: string }

/** id → route. iosIcon values are SF Symbol names. */
export const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: 'orders', title: 'অর্ডার', description: 'নতুন ও চলমান অর্ডার', iosIcon: 'bag.fill', path: '/orders' },
  { id: 'inventory', title: 'ইনভেন্টরি', description: 'স্টক ও পণ্য', iosIcon: 'archivebox.fill', path: '/inventory' },
  { id: 'payroll', title: 'পেরোল', description: 'বেতন ও ওয়ালেট', iosIcon: 'creditcard.fill', path: '/payroll' },
  { id: 'assistant', title: 'অ্যাসিস্ট্যান্ট', description: 'AI সহকারী', iosIcon: 'sparkles', path: '/agent' },
]

const PATH_BY_ID = new Map(QUICK_ACTIONS.map(a => [a.id, a.path]))

/** Register the static shortcuts. No-op off native; never throws. */
export async function registerAppShortcuts(): Promise<void> {
  if (!isCapacitorNative()) return
  try {
    await AppShortcuts.set({
      shortcuts: QUICK_ACTIONS.map(({ id, title, description, iosIcon }) => ({
        id,
        title,
        description,
        iosIcon,
      })),
    })
  } catch {
    /* shortcuts are a nice-to-have — never let a failure surface */
  }
}

/** Resolve a shortcut id to its in-app route, or null if unknown. */
export function shortcutPath(shortcutId: string): string | null {
  return PATH_BY_ID.get(shortcutId) ?? null
}
