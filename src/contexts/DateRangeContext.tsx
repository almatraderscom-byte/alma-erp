'use client'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  type DatePreset,
  type DateRange,
  getDatePresetRange,
  formatDateRangeLabel,
} from '@/lib/order-analytics'

const STORAGE_KEY = 'alma-date-range'

interface DateRangeState {
  preset: DatePreset
  customStart: string
  customEnd: string
}

interface DateRangeContextValue {
  preset: DatePreset
  customStart: string
  customEnd: string
  range: DateRange
  label: string
  setPreset: (preset: DatePreset) => void
  setCustomRange: (start: string, end: string) => void
}

const DateRangeContext = createContext<DateRangeContextValue | null>(null)

function loadState(): DateRangeState {
  if (typeof window === 'undefined') {
    return { preset: 'last30', customStart: '', customEnd: '' }
  }
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return { preset: 'last30', customStart: '', customEnd: '' }
    const parsed = JSON.parse(raw) as DateRangeState
    return {
      preset: parsed.preset ?? 'last30',
      customStart: parsed.customStart ?? '',
      customEnd: parsed.customEnd ?? '',
    }
  } catch {
    return { preset: 'last30', customStart: '', customEnd: '' }
  }
}

function saveState(state: DateRangeState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* ignore quota */ }
}

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DateRangeState>(() => loadState())

  const range = useMemo(
    () => getDatePresetRange(state.preset, state.customStart, state.customEnd),
    [state.preset, state.customStart, state.customEnd],
  )

  const label = useMemo(
    () => formatDateRangeLabel(range, state.preset),
    [range, state.preset],
  )

  const setPreset = useCallback((preset: DatePreset) => {
    setState(prev => {
      const next = { ...prev, preset }
      saveState(next)
      return next
    })
  }, [])

  const setCustomRange = useCallback((start: string, end: string) => {
    setState(prev => {
      const next = { preset: 'custom' as DatePreset, customStart: start, customEnd: end }
      saveState(next)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({
      preset: state.preset,
      customStart: state.customStart,
      customEnd: state.customEnd,
      range,
      label,
      setPreset,
      setCustomRange,
    }),
    [state, range, label, setPreset, setCustomRange],
  )

  return (
    <DateRangeContext.Provider value={value}>
      {children}
    </DateRangeContext.Provider>
  )
}

export function useDateRange() {
  const ctx = useContext(DateRangeContext)
  if (!ctx) throw new Error('useDateRange must be used within DateRangeProvider')
  return ctx
}
