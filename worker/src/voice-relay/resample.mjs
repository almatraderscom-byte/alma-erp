/**
 * Streaming sample-rate conversion for the telephony audio path.
 *
 * WHY THIS EXISTS (owner-reported "jhirjhir" crackle, root-caused 2026-07-25):
 * Gemini Live always emits 24 kHz audio and the PSTN carries 8 kHz, so every reply has to be
 * downsampled. The bot did that by averaging each group of 3 samples — which is NOT a
 * low-pass filter. Measured on the real code: a 5 kHz tone (which MUST be removed, since
 * 8 kHz audio can only represent up to 4 kHz) survived at about half amplitude and folded
 * back to 3 kHz, i.e. straight into the middle of the voice band. Sibilants and consonant
 * bursts in Gemini's 24 kHz speech are full of 5–11 kHz energy, so a large part of every
 * "স/শ/ছ" was landing in the ear as broadband grit. The same averaging also cut 3.8 kHz by
 * ~3 dB, muffling the voice.
 *
 * The fix is the textbook one: low-pass BELOW the output Nyquist first, then decimate —
 * a linear-phase windowed-sinc FIR. Two details matter as much as the filter itself:
 *   1. STATE IS KEPT ACROSS CHUNKS. Audio arrives in ~20 ms pieces; filtering each piece
 *      independently would restart the filter 50×/second and click at every boundary.
 *   2. The cutoff is 3.4 kHz — the actual telephony passband — so we are not fighting to
 *      preserve content the phone line would destroy anyway.
 *
 * Cost is trivial in context: decimation only computes the samples it keeps, so 24k->8k is
 * ~8000 outputs/sec × taps, a fraction of a millisecond per 20 ms frame.
 */

/**
 * Windowed-sinc low-pass FIR (Blackman window, ~-74 dB stopband, linear phase).
 * @param {number} taps  odd, so the filter has an exact centre and integer delay
 * @param {number} cutoffHz  -6 dB point
 * @param {number} rateHz  sample rate the filter runs at
 * @param {number} gain  passband gain (upsampling needs gain = L to restore level)
 */
function designLowPass(taps, cutoffHz, rateHz, gain = 1) {
  const n = taps % 2 === 1 ? taps : taps + 1
  const fc = cutoffHz / rateHz // normalised (cycles/sample)
  const mid = (n - 1) / 2
  const h = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const x = i - mid
    // sinc
    const s = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
    // Blackman window
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1))
    h[i] = s * w
    sum += h[i]
  }
  // Normalise DC gain to exactly `gain` so levels never drift.
  for (let i = 0; i < n; i++) h[i] = (h[i] / sum) * gain
  return h
}

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0)

/**
 * Integer-factor decimator (e.g. 24 kHz -> 8 kHz, factor 3) with filter state carried
 * across calls. Feed it PCM16LE, get PCM16LE at rateIn/factor.
 */
export function createDecimator({ rateIn, factor, cutoffHz = 3600, taps = 241 }) {
  // 3.6 kHz measured as the sweet spot for 24k->8k: the telephony voice band (up to
  // 3.4 kHz) comes through at -0.2 dB, while everything that would alias (4.5 kHz+) is
  // already below -70 dB. Pulling the cutoff down to 3.4 kHz cost 6 dB of real speech
  // for no measurable gain in alias rejection.
  const h = designLowPass(taps, cutoffHz, rateIn)
  const n = h.length
  // History holds the previous n-1 input samples so filtering is continuous across chunks.
  let hist = new Float64Array(n - 1)
  let phase = 0 // which input sample the next output should be taken at

  return function decimate(pcmIn) {
    const inCount = pcmIn.length >> 1
    if (inCount === 0) return Buffer.alloc(0)
    const buf = new Float64Array(hist.length + inCount)
    buf.set(hist, 0)
    for (let i = 0; i < inCount; i++) buf[hist.length + i] = pcmIn.readInt16LE(i * 2)

    // Output sample k is the filter evaluated at input index (phase + k*factor).
    const out = []
    for (let pos = phase; pos + n <= buf.length; pos += factor) {
      let acc = 0
      for (let j = 0; j < n; j++) acc += buf[pos + j] * h[j]
      out.push(clamp16(Math.round(acc)))
    }
    // Carry the tail forward, and remember where the next output lands inside it.
    const consumed = out.length ? phase + out.length * factor : phase
    const keepFrom = Math.max(0, buf.length - (n - 1))
    hist = buf.slice(keepFrom)
    phase = Math.max(0, consumed - keepFrom)

    const res = Buffer.allocUnsafe(out.length * 2)
    for (let i = 0; i < out.length; i++) res.writeInt16LE(out[i], i * 2)
    return res
  }
}

/**
 * Integer-factor interpolator (e.g. 8 kHz -> 16 kHz, factor 2): zero-stuff then low-pass,
 * which removes the spectral images that plain linear interpolation leaves behind. State is
 * kept across chunks for the same reason as above.
 */
export function createInterpolator({ rateOut, factor, cutoffHz = 3800, taps = 97 }) {
  const h = designLowPass(taps, cutoffHz, rateOut, factor)
  const n = h.length
  let hist = new Float64Array(n - 1)

  return function interpolate(pcmIn) {
    const inCount = pcmIn.length >> 1
    if (inCount === 0) return Buffer.alloc(0)
    // Zero-stuffed stream at the OUTPUT rate.
    const up = new Float64Array(inCount * factor)
    for (let i = 0; i < inCount; i++) up[i * factor] = pcmIn.readInt16LE(i * 2)

    const buf = new Float64Array(hist.length + up.length)
    buf.set(hist, 0)
    buf.set(up, hist.length)

    const outCount = buf.length - (n - 1)
    const res = Buffer.allocUnsafe(Math.max(0, outCount) * 2)
    for (let k = 0; k < outCount; k++) {
      let acc = 0
      for (let j = 0; j < n; j++) acc += buf[k + j] * h[j]
      res.writeInt16LE(clamp16(Math.round(acc)), k * 2)
    }
    hist = buf.slice(Math.max(0, buf.length - (n - 1)))
    return res
  }
}
