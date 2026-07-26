'use client'

import {
  CAPTION_PLACEMENTS,
  VIDEO_CROP_ASPECTS,
  VIDEO_EDIT_TRACKS,
  editedDurationSec,
  type TimelineSegment,
  type VideoEditContract,
} from '@/lib/creative-studio/video-edit-contract'
import { cn } from '@/lib/utils'

export function TimelineLite({
  value,
  onChange,
}: {
  value: VideoEditContract
  onChange: (value: VideoEditContract) => void
}) {
  const updateSegment = (id: string, patch: Partial<TimelineSegment>) => {
    onChange({
      ...value,
      segments: value.segments.map((segment) => segment.id === id ? { ...segment, ...patch } : segment),
    })
  }
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= value.segments.length) return
    const segments = [...value.segments]
    ;[segments[index], segments[target]] = [segments[target], segments[index]]
    onChange({ ...value, segments: segments.map((segment, order) => ({ ...segment, order })) })
  }
  const addSegment = () => {
    const last = value.segments.at(-1)
    const startSec = Math.min(value.sourceDurationSec - 0.5, last?.endSec ?? 0)
    const endSec = Math.min(value.sourceDurationSec, startSec + Math.min(3, value.sourceDurationSec))
    if (endSec - startSec < 0.1) return
    onChange({
      ...value,
      segments: [
        ...value.segments,
        { id: `clip-${Date.now()}`, startSec, endSec, order: value.segments.length },
      ],
    })
  }

  const aspectRatio = value.crop.aspect === 'original'
    ? '16 / 9'
    : value.crop.aspect.replace(':', ' / ')
  const outputDuration = editedDurationSec(value)
  const trackLabels = { visual: 'ভিডিও', captions: 'ক্যাপশন', audio: 'অডিও', cover: 'কভার' }

  return (
    <div className="space-y-3 rounded-xl border border-[#E07A5F]/25 bg-bg-1/50 p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[12px] font-bold text-cream">✂️ Timeline-lite</p>
          <p className="text-[11px] text-muted">মূল source বদলাবে না · output {outputDuration.toFixed(1)}s</p>
        </div>
        <button type="button" onClick={addSegment} className="st-chip px-2 py-1 text-[11px]">+ ক্লিপ</button>
      </div>

      <div className="space-y-1.5">
        {value.segments.map((segment, index) => (
          <div key={segment.id} className="grid grid-cols-[28px_1fr_1fr_56px] items-center gap-1.5 rounded-lg bg-white/[0.04] p-2">
            <span className="text-center text-[11px] font-bold text-[#E07A5F]">{index + 1}</span>
            <label className="text-[11px] text-muted">
              শুরু
              <input
                aria-label={`ক্লিপ ${index + 1} শুরু`}
                type="number"
                min={0}
                max={segment.endSec - 0.1}
                step={0.1}
                value={segment.startSec}
                onChange={(event) => updateSegment(segment.id, { startSec: Number(event.target.value) })}
                className="mt-0.5 w-full rounded bg-black/30 px-1.5 py-1 text-[11px] text-cream"
              />
            </label>
            <label className="text-[11px] text-muted">
              শেষ
              <input
                aria-label={`ক্লিপ ${index + 1} শেষ`}
                type="number"
                min={segment.startSec + 0.1}
                max={value.sourceDurationSec}
                step={0.1}
                value={segment.endSec}
                onChange={(event) => updateSegment(segment.id, { endSec: Number(event.target.value) })}
                className="mt-0.5 w-full rounded bg-black/30 px-1.5 py-1 text-[11px] text-cream"
              />
            </label>
            <div className="flex justify-end gap-1">
              <button type="button" aria-label="আগে নিন" onClick={() => move(index, -1)} className="st-chip h-6 w-6 text-[11px]">↑</button>
              <button type="button" aria-label="পরে নিন" onClick={() => move(index, 1)} className="st-chip h-6 w-6 text-[11px]">↓</button>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-[150px_1fr]">
        <div
          className="relative mx-auto w-full max-w-[150px] overflow-hidden rounded-lg bg-gradient-to-br from-[#E07A5F]/35 to-black/60 ring-1 ring-white/15"
          style={{ aspectRatio }}
          aria-label="Safe-zone preview"
        >
          <div className="absolute inset-[10%] rounded border border-dashed border-white/60" />
          <div className="absolute left-[8%] right-[8%] top-[15%] border-t border-dashed border-white/25" />
          <div className="absolute bottom-[18%] left-[8%] right-[8%] border-t border-dashed border-white/25" />
          <span
            className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#E07A5F] ring-2 ring-black/50"
            style={{ left: `${value.crop.focusX * 100}%`, top: `${value.crop.focusY * 100}%` }}
          />
          <span className="absolute bottom-1 left-1 text-[11px] font-semibold text-white/70">SAFE ZONE</span>
        </div>
        <div className="space-y-2">
          <div>
            <p className="mb-1 text-[11px] font-semibold text-muted">Crop</p>
            <div className="flex flex-wrap gap-1">
              {VIDEO_CROP_ASPECTS.map((aspect) => (
                <button
                  key={aspect}
                  type="button"
                  onClick={() => onChange({ ...value, crop: { ...value.crop, aspect } })}
                  className={cn('rounded px-2 py-1 text-[11px] font-semibold', value.crop.aspect === aspect ? 'st-chip-on' : 'st-chip')}
                >
                  {aspect === 'original' ? 'মূল' : aspect}
                </button>
              ))}
            </div>
          </div>
          {(['focusX', 'focusY'] as const).map((axis) => (
            <label key={axis} className="block text-[11px] text-muted">
              {axis === 'focusX' ? 'Focus ↔' : 'Focus ↕'}
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={value.crop[axis]}
                onChange={(event) => onChange({
                  ...value,
                  crop: { ...value.crop, [axis]: Number(event.target.value) },
                })}
                className="block w-full accent-[#E07A5F]"
              />
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1 text-[11px] font-semibold text-muted">Track volume</p>
        <div className="grid grid-cols-3 gap-2">
          {(['original', 'music', 'voiceover'] as const).map((track) => (
            <label key={track} className="text-[11px] text-muted">
              {track === 'original' ? 'মূল' : track === 'music' ? 'মিউজিক' : 'ভয়েস'}
              <input
                aria-label={`${track} volume`}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={value.volumes[track]}
                onChange={(event) => onChange({
                  ...value,
                  volumes: { ...value.volumes, [track]: Number(event.target.value) },
                })}
                className="block w-full accent-[#E07A5F]"
              />
              <span>{Math.round(value.volumes[track] * 100)}%</span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-[11px] font-semibold text-muted">ক্যাপশন কোথায়</p>
          <div className="flex gap-1">
            {CAPTION_PLACEMENTS.map((placement) => (
              <button
                key={placement}
                type="button"
                onClick={() => onChange({ ...value, captionPlacement: placement })}
                className={cn('rounded px-2 py-1 text-[11px]', value.captionPlacement === placement ? 'st-chip-on' : 'st-chip')}
              >
                {placement === 'top' ? 'উপরে' : placement === 'center' ? 'মাঝে' : 'নিচে'}
              </button>
            ))}
          </div>
        </div>
        <label className="text-[11px] font-semibold text-muted">
          Cover frame · {value.cover.atSec.toFixed(1)}s
          <input
            aria-label="Cover frame time"
            type="range"
            min={0}
            max={Math.max(0.5, outputDuration)}
            step={0.1}
            value={value.cover.atSec}
            onChange={(event) => onChange({ ...value, cover: { atSec: Number(event.target.value) } })}
            className="block w-full accent-[#E07A5F]"
          />
        </label>
      </div>

      <div>
        <p className="mb-1 text-[11px] font-semibold text-muted">এইবার যে track-গুলো render হবে</p>
        <div className="flex flex-wrap gap-2">
          {VIDEO_EDIT_TRACKS.map((track) => (
            <label key={track} className="flex items-center gap-1 text-[11px] text-cream">
              <input
                type="checkbox"
                checked={value.rerender.includes(track)}
                onChange={(event) => onChange({
                  ...value,
                  rerender: event.target.checked
                    ? Array.from(new Set([...value.rerender, track]))
                    : value.rerender.filter((item) => item !== track),
                })}
                className="accent-[#E07A5F]"
              />
              {trackLabels[track]}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
