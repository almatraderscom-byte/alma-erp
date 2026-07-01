import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Orb from './Orb';
import { useMockAudio } from './useMockAudio';
import { MicIcon, CloseIcon, SlidersIcon } from './icons';

const LABEL = { idle: 'Tap the mic to speak', listening: 'Listening…', thinking: 'Thinking…' };
const STATES = ['idle', 'listening', 'thinking'];

/**
 * VoiceMode — full-screen mobile-first voice UI.
 * Owns the interaction state machine and light/dark theme.
 */
export default function VoiceMode() {
  const [state, setState] = useState('idle');
  const [dark, setDark] = useState(false);
  const level = useMockAudio(state === 'listening');

  // "thinking" is a transient state that resolves back to idle (mock processing)
  useEffect(() => {
    if (state !== 'thinking') return;
    const id = setTimeout(() => setState('idle'), 2600);
    return () => clearTimeout(id);
  }, [state]);

  const onMic = useCallback(() => setState((s) => (s === 'listening' ? 'thinking' : 'listening')), []);
  const onClose = useCallback(() => setState('idle'), []);

  return (
    <div className={`screen ${dark ? 'dark' : 'light'} relative w-full h-full flex flex-col items-center select-none`}>
      {/* settings / theme toggle */}
      <button
        onClick={() => setDark((d) => !d)}
        title="Toggle light / dark"
        className="absolute top-4 right-4 grid h-11 w-11 place-items-center rounded-full text-slate-400 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
      >
        <SlidersIcon />
      </button>

      {/* status line */}
      <div className="pt-7 text-[13px] font-medium uppercase tracking-[0.14em] opacity-60">
        <AnimatePresence mode="wait">
          <motion.span
            key={state}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
          >
            {state === 'idle' ? (
              <>Tap the mic to <b className="text-blue-500">speak</b></>
            ) : (
              LABEL[state]
            )}
          </motion.span>
        </AnimatePresence>
      </div>

      {/* demo state switcher (exercises all three states from the spec) */}
      <div className="mt-3 flex gap-2">
        {STATES.map((s) => (
          <button
            key={s}
            onClick={() => setState(s)}
            className={`rounded-full border px-3 py-1 text-[11px] capitalize transition-colors ${
              state === s
                ? 'border-blue-500 bg-blue-500 text-white'
                : 'border-slate-300/60 text-slate-500 dark:border-white/20 dark:text-slate-300'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* orb */}
      <div className="grid w-full flex-1 place-items-center">
        <Orb state={state} level={level} />
      </div>

      {/* bottom controls */}
      <div className="flex w-full max-w-xs items-center justify-between px-10 pb-10"
           style={{ paddingBottom: 'max(2.5rem, env(safe-area-inset-bottom))' }}>
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={onMic}
          aria-label="Microphone"
          className={`grid h-16 w-16 place-items-center rounded-full shadow-lg transition-colors ${
            state === 'listening' ? 'bg-blue-500 text-white' : 'bg-white text-slate-900'
          }`}
        >
          <MicIcon />
        </motion.button>

        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={onClose}
          aria-label="Close"
          className="grid h-16 w-16 place-items-center rounded-full bg-white text-slate-900 shadow-lg"
        >
          <CloseIcon />
        </motion.button>
      </div>
    </div>
  );
}
