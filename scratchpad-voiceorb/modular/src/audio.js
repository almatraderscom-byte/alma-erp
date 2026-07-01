// audio.js — microphone capture + frequency analysis with graceful idle decay.

export class AudioEngine {
  constructor(gain = 1.6){
    this.gain = gain;
    this.active = false;
    this.level = 0; this.low = 0; this.high = 0;
    this._ctx = null; this._analyser = null; this._stream = null; this._data = null;
  }

  async start(){
    if(this.active) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    src.connect(analyser);
    if(ctx.state === 'suspended') await ctx.resume();

    this._ctx = ctx; this._analyser = analyser; this._stream = stream;
    this._data = new Uint8Array(analyser.frequencyBinCount);
    this.active = true;
  }

  stop(){
    if(!this.active) return;
    this._stream.getTracks().forEach(t => t.stop());
    this._ctx.close();
    this.active = false;
    this.level = this.low = this.high = 0;
  }

  // Call once per frame. Smooths towards target; decays to 0 when inactive.
  sample(){
    if(!this.active){ this.level *= 0.9; this.low *= 0.9; this.high *= 0.9; return; }
    this._analyser.getByteFrequencyData(this._data);
    const n = this._data.length;
    const split = Math.floor(n * 0.15);
    let lowSum = 0, highSum = 0, all = 0;
    for(let i = 0; i < n; i++){
      const v = this._data[i] / 255; all += v;
      if(i < split) lowSum += v; else highSum += v;
    }
    const g = this.gain;
    const level = (all / n) * g;
    const low = (lowSum / split) * g;
    const high = (highSum / (n - split)) * g;
    this.level += (level - this.level) * 0.35;
    this.low   += (low   - this.low)   * 0.35;
    this.high  += (high  - this.high)  * 0.40;
  }
}
