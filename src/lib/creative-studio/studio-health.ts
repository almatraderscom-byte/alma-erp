export type WorkerHealthState = 'healthy' | 'delayed' | 'offline' | 'unknown'

export type WorkerHealth = {
  state: WorkerHealthState
  labelBn: string
  heartbeatAt: string | null
  heartbeatAgeSec: number | null
  healthy: boolean
}

const LABELS: Record<WorkerHealthState, string> = {
  healthy: 'সচল',
  delayed: 'দেরি হচ্ছে',
  offline: 'অফলাইন',
  unknown: 'অজানা',
}

export function classifyWorkerHeartbeat(
  heartbeatAt: Date | string | null | undefined,
  nowMs = Date.now(),
  healthyWithinSec = 180,
  delayedWithinSec = 600,
): WorkerHealth {
  if (!heartbeatAt) {
    return {
      state: 'unknown',
      labelBn: LABELS.unknown,
      heartbeatAt: null,
      heartbeatAgeSec: null,
      healthy: false,
    }
  }

  const timestamp = heartbeatAt instanceof Date ? heartbeatAt.getTime() : new Date(heartbeatAt).getTime()
  if (!Number.isFinite(timestamp)) {
    return {
      state: 'unknown',
      labelBn: LABELS.unknown,
      heartbeatAt: null,
      heartbeatAgeSec: null,
      healthy: false,
    }
  }

  const heartbeatAgeSec = Math.max(0, Math.round((nowMs - timestamp) / 1000))
  const state: WorkerHealthState =
    heartbeatAgeSec < healthyWithinSec
      ? 'healthy'
      : heartbeatAgeSec < delayedWithinSec
        ? 'delayed'
        : 'offline'

  return {
    state,
    labelBn: LABELS[state],
    heartbeatAt: new Date(timestamp).toISOString(),
    heartbeatAgeSec,
    healthy: state === 'healthy',
  }
}

export function formatHeartbeatAgeBn(ageSec: number | null): string {
  if (ageSec === null) return 'শেষ সিগন্যাল পাওয়া যায়নি'
  if (ageSec < 60) return `${ageSec} সেকেন্ড আগে`
  if (ageSec < 3600) return `${Math.max(1, Math.round(ageSec / 60))} মিনিট আগে`
  return `${Math.max(1, Math.round(ageSec / 3600))} ঘণ্টা আগে`
}
