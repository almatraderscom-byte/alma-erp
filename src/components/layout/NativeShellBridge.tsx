'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { isNativeShell, isNativeHeaderMode } from '@/lib/native-shell'
import { installNativeContextMenu } from '@/lib/native-context-menu'

/**
 * Bridges the web app to the native iOS shell when running inside it (embed mode).
 *
 *  1. Adds `alma-native` to <html> so CSS can hide the web's own chrome (the mobile
 *     bottom nav and the agent sub-nav) — see globals.css. Done in an effect (after
 *     mount) so server-rendered markup is unchanged and there is no hydration
 *     mismatch.
 *  2. Reports every App Router route change to native:
 *       window.webkit.messageHandlers.almaShell.postMessage({ type, path, title })
 *     so the native side can show a native header/title and manage back.
 *
 * Fully gated + fail-open: in a normal browser `isNativeShell()` is false and this
 * renders nothing and posts nothing. If the native message handler is absent it
 * silently no-ops.
 */
export function NativeShellBridge() {
  const pathname = usePathname()

  // Toggle the embed-mode class(es) once, on mount.
  useEffect(() => {
    if (!isNativeShell()) return
    const root = document.documentElement
    root.classList.add('alma-native')
    // Pages shown under a native header hide their own .page-header (no double bar).
    if (isNativeHeaderMode()) root.classList.add('alma-native-hdr')
    // The Assistant tab's agent sub-nav (Chat/Studio/WhatsApp/Monitor/Costs) is
    // replaced by a NATIVE segmented control in build 26+, which injects
    // `window.__almaAgentNative`. Only then hide the web sub-nav — older builds
    // (24/25) keep the web sub-nav so its sections stay reachable.
    const agentNativeNav = Boolean(
      (window as unknown as { __almaAgentNative?: boolean }).__almaAgentNative,
    )
    if (agentNativeNav) root.classList.add('alma-agent-native')
    post({ type: 'ready' })
    // Long-press → native action sheet for any [data-ctx-menu] element (order cards …).
    const uninstallCtx = installNativeContextMenu()
    return () => {
      root.classList.remove('alma-native', 'alma-native-hdr', 'alma-agent-native')
      uninstallCtx()
    }
  }, [])

  // Report route (path + best-effort title) on every navigation.
  useEffect(() => {
    if (!isNativeShell()) return
    post({ type: 'route', path: pathname ?? '/', title: titleFor(pathname ?? '/') })
  }, [pathname])

  return null
}

function post(message: Record<string, unknown>): void {
  try {
    const handler = (
      window as unknown as {
        webkit?: { messageHandlers?: { almaShell?: { postMessage: (m: unknown) => void } } }
      }
    ).webkit?.messageHandlers?.almaShell
    handler?.postMessage(message)
  } catch {
    /* not in the native shell — no-op */
  }
}

/** Human title for the native header. Prefers the real document title, else derives
 *  one from the path (`/orders/123` → "Order 123", `/orders` → "Orders"). */
function titleFor(path: string): string {
  const docTitle = typeof document !== 'undefined' ? document.title.trim() : ''
  if (docTitle && !/^alma/i.test(docTitle)) return docTitle

  const seg = path.split('/').filter(Boolean)
  if (seg.length === 0) return 'Dashboard'
  const SECTION: Record<string, string> = {
    orders: 'Orders', agent: 'Assistant', approvals: 'Approvals', finance: 'Finance',
    inventory: 'Inventory', employees: 'Employees', payroll: 'Payroll', expenses: 'Expenses',
    crm: 'CRM', analytics: 'Analytics', insights: 'Insights', attendance: 'Attendance',
    invoice: 'Invoices', trading: 'Trading', digital: 'Digital', activity: 'Activity',
    audit: 'Audit', briefing: 'Briefing', settings: 'Settings',
  }
  const head = SECTION[seg[0]] ?? cap(seg[0])
  if (seg.length === 1) return head
  const tail = seg[seg.length - 1]
  // singular-ish detail label, e.g. orders/123 → "Order 123"
  const singular = head.endsWith('s') ? head.slice(0, -1) : head
  return `${singular} ${cap(tail)}`
}

function cap(s: string): string {
  const clean = s.replace(/[-_]/g, ' ')
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}
