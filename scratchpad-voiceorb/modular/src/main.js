// main.js — wires the VoiceOrb to the DOM UI (mic button, settings panel, FPS meter).
import { VoiceOrb, PALETTES } from './VoiceOrb.js';

const mount = document.getElementById('app');
const orb = new VoiceOrb(mount);
window._orb = orb;

// FPS meter
const fpsEl = document.getElementById('fps');
let frames = 0, last = performance.now();
(function loop(){
  frames++; const now = performance.now();
  if(now - last >= 1000){ fpsEl.textContent = frames + ' FPS'; frames = 0; last = now; }
  requestAnimationFrame(loop);
})();

// Mic toggle
const micBtn = document.getElementById('mic');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
micBtn.addEventListener('click', async () => {
  if(orb.audio.active){
    orb.stopMic(); micBtn.classList.remove('live');
    statusEl.innerHTML = 'Tap the mic to <b>speak</b>';
  } else {
    try {
      statusEl.innerHTML = '<b>Listening…</b>';
      await orb.startMic();
      micBtn.classList.add('live');
      hintEl.style.opacity = '0';
    } catch(e){
      statusEl.innerHTML = 'Microphone <b>blocked</b> — allow access';
      console.warn(e);
    }
  }
});
document.getElementById('close').addEventListener('click', () => {
  orb.stopMic(); micBtn.classList.remove('live');
  statusEl.innerHTML = 'Tap the mic to <b>speak</b>';
});
setTimeout(() => { hintEl.style.opacity = '0'; }, 6000);

// Settings panel
const panel = document.getElementById('panel');
document.getElementById('panelToggle').addEventListener('click', () => panel.classList.toggle('open'));

function bindSlider(id, key, valId){
  const el = document.getElementById(id), vEl = document.getElementById(valId);
  const sync = () => { const v = parseFloat(el.value); orb.params[key] = v; vEl.textContent = v.toFixed(2); };
  el.addEventListener('input', sync); sync();
}
bindSlider('s_deform', 'deform', 'v_deform');
bindSlider('s_speed', 'speed', 'v_speed');
bindSlider('s_detail', 'detail', 'v_detail');
bindSlider('s_bloom', 'bloom', 'v_bloom');
bindSlider('s_aura', 'aura', 'v_aura');
bindSlider('s_mic', 'micGain', 'v_mic');

// Palette swatches
const sw = document.getElementById('swatches');
PALETTES.forEach((p, i) => {
  const el = document.createElement('div');
  el.className = 'sw' + (i === 0 ? ' active' : '');
  el.style.background = `linear-gradient(135deg, ${p.a}, ${p.b})`;
  el.title = p.name;
  el.addEventListener('click', () => {
    orb.setPalette(i);
    [...sw.children].forEach(c => c.classList.remove('active'));
    el.classList.add('active');
  });
  sw.appendChild(el);
});
