/**
 * Central z-index scale — feature work must not invent arbitrary layers.
 * Watermark sits above mobile chrome, below overlays/modals.
 */
export const PLATFORM_Z = {
  watermark: 52,
  mobileBottomNav: 50,
  pullToRefresh: 60,
  stickyBanner: 70,
  pageModal: 90,
  notificationPanel: 160,
  fullScreenModal: 10_000,
  opsTaskDock: 10_055,
  loadingOverlay: 240,
} as const
