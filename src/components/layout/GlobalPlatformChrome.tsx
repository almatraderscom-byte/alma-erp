'use client'

import { AppShortcutsManager } from '@/components/layout/AppShortcutsManager'
import { BiometricLockGate } from '@/components/layout/BiometricLockGate'
import { DeepLinkManager } from '@/components/layout/DeepLinkManager'
import { DeveloperWatermark } from '@/components/layout/DeveloperWatermark'
import { ForcedUpdateGate } from '@/components/layout/ForcedUpdateGate'
import { LivePulseManager } from '@/components/layout/LivePulseManager'
import { LocalRemindersManager } from '@/components/layout/LocalRemindersManager'
import { NativeShellBridge } from '@/components/layout/NativeShellBridge'
import { PlatformDiagnostics } from '@/components/layout/PlatformDiagnostics'

/**
 * Global shell chrome mounted once from root layout.
 * Keeps watermark + diagnostics outside page-level wrappers so refactors cannot drop them.
 */
export function GlobalPlatformChrome() {
  return (
    <>
      <DeveloperWatermark />
      <PlatformDiagnostics />
      <ForcedUpdateGate />
      <BiometricLockGate />
      <AppShortcutsManager />
      <LocalRemindersManager />
      <LivePulseManager />
      <DeepLinkManager />
      <NativeShellBridge />
    </>
  )
}
