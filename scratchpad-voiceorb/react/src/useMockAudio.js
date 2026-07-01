import { useEffect, useRef, useState } from 'react';

/**
 * useMockAudio — produces a smoothed "microphone volume" in the range 0..1
 * while `active` is true. It mocks a speech-like envelope (layered sines +
 * jitter) per the spec. Swap the body for a real Web Audio AnalyserNode to go
 * live:  analyser.getByteFrequencyData(...) -> average -> setLevel().
 */
export function useMockAudio(active) {
  const [level, setLevel] = useState(0);
  const smoothed = useRef(0);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      smoothed.current = 0;
      return;
    }
    let raf;
    let t = 0;
    const tick = () => {
      t += 0.055;
      // two sines at different rates + random jitter ≈ natural speech loudness
      const envelope =
        0.42 + 0.34 * Math.sin(t * 2.1) + 0.18 * Math.sin(t * 5.7 + 1.3);
      const target = Math.max(0, Math.min(1, envelope * (0.7 + Math.random() * 0.4)));
      // exponential smoothing so the orb never jitters harshly
      smoothed.current += (target - smoothed.current) * 0.25;
      setLevel(smoothed.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return level;
}
