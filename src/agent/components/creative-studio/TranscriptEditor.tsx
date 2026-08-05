'use client'

import { editedDurationSec, type TranscriptCue, type VideoEditContract } from '@/lib/creative-studio/video-edit-contract'

export function TranscriptEditor({
  value,
  onChange,
}: {
  value: VideoEditContract
  onChange: (value: VideoEditContract) => void
}) {
  const duration = editedDurationSec(value)
  const update = (id: string, patch: Partial<TranscriptCue>) => {
    onChange({
      ...value,
      transcript: value.transcript.map((cue) => cue.id === id ? { ...cue, ...patch } : cue),
    })
  }
  const add = (track: TranscriptCue['track']) => {
    const previous = value.transcript.at(-1)
    const startSec = Math.min(Math.max(0, duration - 0.5), previous?.endSec ?? 0)
    const endSec = Math.min(duration, startSec + Math.min(2, duration))
    onChange({
      ...value,
      transcript: [
        ...value.transcript,
        {
          id: `cue-${Date.now()}`,
          track,
          startSec,
          endSec: Math.max(startSec + 0.1, endSec),
          text: track === 'caption' ? 'নতুন ক্যাপশন' : 'নতুন ভয়েসওভার লাইন',
        },
      ],
    })
  }

  return (
    <div className="space-y-2 rounded-xl border border-border-subtle bg-bg-1/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-bold text-cream">📝 Transcript + timing</p>
          <p className="text-[11px] text-muted">Caption ও voiceover আলাদা track; সময় সরাসরি বদলান।</p>
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={() => add('caption')} className="st-chip px-2 py-1 text-[11px]">+ Caption</button>
          <button type="button" onClick={() => add('voiceover')} className="st-chip px-2 py-1 text-[11px]">+ Voice</button>
        </div>
      </div>

      {value.transcript.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-muted">
          এখনো কোনো timed line নেই।
        </p>
      ) : (
        <div className="space-y-1.5">
          {value.transcript.map((cue, index) => (
            <div key={cue.id} className="grid grid-cols-[58px_1fr_24px] gap-1.5 rounded-lg bg-white/[0.04] p-2">
              <div className="space-y-1">
                <span className="block rounded bg-white/10 px-1 py-0.5 text-center text-[11px] font-bold text-muted">
                  {cue.track === 'caption' ? 'CAPTION' : 'VOICE'}
                </span>
                <input
                  aria-label={`লাইন ${index + 1} শুরু`}
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={cue.startSec}
                  onChange={(event) => update(cue.id, { startSec: Number(event.target.value) })}
                  className="w-full rounded bg-black/30 px-1 py-1 text-[11px] text-cream"
                />
                <input
                  aria-label={`লাইন ${index + 1} শেষ`}
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={cue.endSec}
                  onChange={(event) => update(cue.id, { endSec: Number(event.target.value) })}
                  className="w-full rounded bg-black/30 px-1 py-1 text-[11px] text-cream"
                />
              </div>
              <textarea
                aria-label={`লাইন ${index + 1} লেখা`}
                value={cue.text}
                onChange={(event) => update(cue.id, { text: event.target.value.slice(0, 240) })}
                rows={3}
                className="w-full rounded-lg border border-border-subtle bg-black/20 px-2 py-1.5 text-[11px] text-cream"
              />
              <button
                type="button"
                aria-label={`লাইন ${index + 1} মুছুন`}
                onClick={() => onChange({ ...value, transcript: value.transcript.filter((item) => item.id !== cue.id) })}
                className="self-start text-[11px] text-muted hover:text-red-400"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
