/**
 * Office Live Intercom styles — injected by intercom.tsx alongside the chat
 * panel. Class prefix `itc-` so nothing collides with OFFICE_CSS. Also carries
 * the iOS-sheet upgrade for the chat panel on phones (full-screen sheet with
 * safe-area insets + the iOS spring curve) so the group chat feels native in
 * the WKWebView shell.
 */
export const INTERCOM_CSS = `
/* ═══ iOS full-screen sheet: the chat panel on phones ═══ */
@media (max-width: 680px) {
  .ohub-chatpanel{
    inset:0; right:0; bottom:0; width:100%; max-width:100%;
    height:100%; max-height:100%; border-radius:0; border:0;
    animation:itc-sheet .38s cubic-bezier(.32,.72,0,1);
  }
  .ohub-chatpanel .cp-head{
    padding-top:max(13px, env(safe-area-inset-top, 0px));
    padding-left:max(15px, env(safe-area-inset-left, 0px));
    padding-right:max(15px, env(safe-area-inset-right, 0px));
  }
  .ohub-chatpanel .cp-foot,
  .ohub-chatpanel .itc-dock{
    padding-bottom:max(12px, env(safe-area-inset-bottom, 0px));
  }
  .ohub-chatpanel .cp-head .x{font-size:24px;padding:4px 10px}
}
@keyframes itc-sheet{from{transform:translateY(12%);opacity:.4}to{transform:none;opacity:1}}

/* ═══ owner PTT dock (inside the chat panel, above the composer) ═══ */
.itc-dock{
  border-top:1px solid rgba(255,255,255,0.07);
  background:rgba(24,24,32,.86);
  backdrop-filter:blur(20px) saturate(1.2);-webkit-backdrop-filter:blur(20px) saturate(1.2);
  padding:10px 12px 12px;
}
.itc-dock-h{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.itc-dock-h .t{font-size:11.5px;font-weight:700;color:#F4A28C;display:inline-flex;align-items:center;gap:6px}
.itc-dock-h .t .dot{width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}
.itc-err{margin-left:auto;font-size:11px;font-weight:600;color:#fca5a5;max-width:60%;text-align:right}

/* target pills — horizontal scroll, iOS segmented feel */
.itc-targets{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;margin-bottom:10px;
  -webkit-overflow-scrolling:touch;scrollbar-width:none}
.itc-targets::-webkit-scrollbar{display:none}
.itc-tpill{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;font-family:inherit;
  font-size:12px;font-weight:600;padding:7px 12px;border-radius:9999px;
  background:#202027;border:1px solid rgba(255,255,255,0.08);color:#D0D4E0;cursor:pointer;
  transition:all .18s cubic-bezier(.32,.72,0,1);-webkit-tap-highlight-color:transparent}
.itc-tpill:active{transform:scale(.95)}
.itc-tpill.on{background:rgba(224,122,95,.16);border-color:rgba(224,122,95,.5);color:#F4A28C;
  box-shadow:0 0 0 1px rgba(224,122,95,.18)}

/* PTT row: [urgent] [PTT] [call] */
.itc-row{display:flex;align-items:center;gap:14px}
.itc-side{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;
  font-family:inherit;font-size:10.5px;font-weight:700;color:#AEB2C0;background:transparent;
  border:0;cursor:pointer;padding:4px;-webkit-tap-highlight-color:transparent;text-decoration:none}
.itc-side .ic{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;font-size:19px;
  background:#202027;border:1px solid rgba(255,255,255,0.10);transition:transform .15s}
.itc-side:active .ic{transform:scale(.9)}
.itc-side.urgent .ic{border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.10)}
.itc-side.urgent{color:#fca5a5}
.itc-side.call .ic{border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.10)}
.itc-side.call{color:#6ee7b7}
.itc-side[aria-disabled="true"]{opacity:.35;pointer-events:none}

.itc-ptt-wrap{position:relative;flex-shrink:0}
.itc-ptt{position:relative;z-index:2;width:84px;height:84px;border-radius:50%;border:0;cursor:pointer;
  font-family:inherit;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
  background:linear-gradient(145deg,#F4A28C,#E07A5F 45%,#C45A3C);
  box-shadow:0 10px 28px rgba(224,122,95,.5),inset 0 2px 0 rgba(255,255,255,.35),inset 0 -5px 12px rgba(0,0,0,.25);
  transition:transform .2s cubic-bezier(.32,.72,0,1),box-shadow .25s,background .25s;
  user-select:none;-webkit-user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent;
  -webkit-touch-callout:none}
.itc-ptt .mic{font-size:24px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35));pointer-events:none}
.itc-ptt .lbl{font-size:9px;font-weight:700;opacity:.95;pointer-events:none}
.itc-ptt:disabled{filter:grayscale(.6);opacity:.6}
.itc-ptt.live{transform:scale(1.08);
  background:linear-gradient(145deg,#ff8a7a,#ff4d4d 45%,#c22626);
  box-shadow:0 10px 38px rgba(255,77,77,.6),inset 0 2px 0 rgba(255,255,255,.35),inset 0 -5px 12px rgba(0,0,0,.3)}
.itc-ptt.cancel{background:linear-gradient(145deg,#71717a,#52525b);box-shadow:0 8px 22px rgba(0,0,0,.4)}
.itc-ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(255,77,77,.6);opacity:0;pointer-events:none}
.itc-ptt-wrap.live .itc-ring{animation:itc-ripple 1.4s ease-out infinite}
.itc-ptt-wrap.live .itc-ring:nth-child(2){animation-delay:.45s}
.itc-ptt-wrap.live .itc-ring:nth-child(3){animation-delay:.9s}
@keyframes itc-ripple{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.85);opacity:0}}

/* live status under the row */
.itc-status{display:flex;align-items:center;justify-content:center;gap:9px;margin-top:9px;min-height:20px}
.itc-status .st{font-size:12px;font-weight:600;color:#AEB2C0;text-align:center}
.itc-status .st.live{color:#fda4a4}
.itc-status .st.cancel{color:#fcd34d}
.itc-status .timer{font-size:12px;font-weight:800;color:#fda4a4;background:rgba(255,77,77,.13);
  border:1px solid rgba(255,77,77,.35);padding:1px 10px;border-radius:9999px;font-variant-numeric:tabular-nums}

/* CSS-only live equalizer (compositor-friendly, no JS per-frame work) */
.itc-eq{display:inline-flex;align-items:center;gap:2.5px;height:16px}
.itc-eq i{width:3px;border-radius:2px;background:currentColor;height:100%;
  animation:itc-eqb 1s ease-in-out infinite;transform-origin:center}
.itc-eq i:nth-child(1){animation-delay:0s;height:40%}
.itc-eq i:nth-child(2){animation-delay:.15s;height:85%}
.itc-eq i:nth-child(3){animation-delay:.3s;height:60%}
.itc-eq i:nth-child(4){animation-delay:.45s;height:95%}
.itc-eq i:nth-child(5){animation-delay:.6s;height:50%}
@keyframes itc-eqb{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1.1)}}

/* ═══ voice bubble in the chat feed ═══ */
.itc-vb{min-width:216px;max-width:100%}
.itc-vb .vb-tag{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;
  color:#fda4a4;background:rgba(255,77,77,.10);border:1px solid rgba(255,77,77,.26);
  border-radius:9999px;padding:2px 8px;margin-bottom:7px}
.itc-vb .vb-row{display:flex;align-items:center;gap:9px}
.itc-vb .vb-play{width:34px;height:34px;border-radius:50%;flex-shrink:0;display:grid;place-items:center;
  font-size:12px;color:#fff;cursor:pointer;border:0;font-family:inherit;
  background:linear-gradient(135deg,#E07A5F,#C45A3C);box-shadow:0 3px 10px rgba(224,122,95,.4);
  transition:transform .15s;-webkit-tap-highlight-color:transparent}
.itc-vb .vb-play:active{transform:scale(.9)}
.itc-bars{flex:1;display:flex;align-items:center;gap:2px;height:26px;position:relative;min-width:90px}
.itc-bars i{flex:1;min-width:2px;border-radius:2px;background:rgba(244,162,140,.38)}
.itc-bars .fill{position:absolute;left:0;top:0;bottom:0;display:flex;align-items:center;gap:2px;
  overflow:hidden;pointer-events:none;width:0%}
.itc-bars .fill i{background:#F4A28C}
.itc-vb .vb-dur{font-size:11px;color:#AEB2C0;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0}
.itc-vb .vb-tr{margin-top:8px;font-size:12px;line-height:1.5;color:#AEB2C0;
  border-top:1px dashed rgba(255,255,255,0.10);padding-top:7px}
.itc-vb .vb-tr b{color:#6ee7b7;font-weight:600}
.itc-vb .vb-tr.pending{color:#71717a;font-style:italic}

/* receipts (owner view) */
.itc-rcpts{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.itc-rcpt{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;
  padding:2.5px 8px;border-radius:9999px;background:#26262e;
  border:1px solid rgba(255,255,255,0.07);color:#71717a;transition:all .3s}
.itc-rcpt.delivered{color:#7dd3fc;border-color:rgba(56,189,248,.3);background:rgba(56,189,248,.08)}
.itc-rcpt.played{color:#fcd34d;border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.08)}
.itc-rcpt.confirmed{color:#6ee7b7;border-color:rgba(34,197,94,.32);background:rgba(34,197,94,.09)}

/* staff self-state on a bubble */
.itc-mystate{margin-top:8px}
.itc-confirm-sm{width:100%;font-family:inherit;font-size:12.5px;font-weight:700;color:#fff;
  padding:9px;border:0;border-radius:12px;cursor:pointer;
  background:linear-gradient(135deg,#22c55e,#15803d);box-shadow:0 4px 14px rgba(34,197,94,.35);
  transition:transform .15s;-webkit-tap-highlight-color:transparent}
.itc-confirm-sm:active{transform:scale(.97)}
.itc-confirm-sm:disabled{opacity:.6}
.itc-donechip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;
  color:#6ee7b7;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);
  padding:3px 10px;border-radius:9999px}

/* urgent bubble */
.itc-vb.urgent{background:linear-gradient(135deg,rgba(239,68,68,.16),rgba(180,30,30,.12))}
.itc-vb.urgent .vb-utitle{font-size:13.5px;font-weight:800;color:#fecaca;display:flex;align-items:center;gap:7px}
.itc-vb.urgent .vb-usub{font-size:11.5px;color:rgba(254,202,202,.75);margin-top:2px}

/* ═══ staff full-screen takeover (walkie-talkie) ═══ */
.itc-takeover{position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;align-items:center;
  justify-content:center;text-align:center;
  padding:calc(30px + env(safe-area-inset-top,0px)) 26px calc(30px + env(safe-area-inset-bottom,0px));
  font-family:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;color:#F7F8FC;
  background:radial-gradient(120% 90% at 50% -10%, rgba(224,122,95,.30), transparent 55%),rgba(9,9,14,.96);
  backdrop-filter:blur(26px) saturate(1.2);-webkit-backdrop-filter:blur(26px) saturate(1.2);
  animation:itc-tk .42s cubic-bezier(.32,.72,0,1)}
@keyframes itc-tk{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:none}}
.itc-takeover.urgent{background:radial-gradient(120% 90% at 50% -10%, rgba(239,68,68,.34), transparent 55%),rgba(14,7,7,.97)}
.itc-tk-av{position:relative;width:104px;height:104px;border-radius:50%;display:grid;place-items:center;
  font-size:38px;font-weight:800;color:#fff;
  background:linear-gradient(135deg,#E07A5F,#C45A3C);
  box-shadow:0 0 0 5px rgba(224,122,95,.26),0 18px 46px rgba(224,122,95,.45)}
.itc-takeover.urgent .itc-tk-av{background:linear-gradient(135deg,#ef4444,#b91c1c);
  box-shadow:0 0 0 5px rgba(239,68,68,.3),0 18px 46px rgba(239,68,68,.4)}
.itc-tk-av .ring{position:absolute;inset:-6px;border-radius:50%;border:2px solid rgba(224,122,95,.55);
  animation:itc-ripple 1.5s ease-out infinite}
.itc-tk-av .ring.r2{animation-delay:.5s}
.itc-tk-kicker{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  color:#F4A28C;margin-top:24px}
.itc-takeover.urgent .itc-tk-kicker{color:#fca5a5}
.itc-tk-title{font-size:22px;font-weight:800;margin-top:4px;letter-spacing:-.01em}
.itc-tk-sub{font-size:12.5px;color:#AEB2C0;margin-top:5px}
.itc-tk-wave{display:flex;align-items:center;justify-content:center;gap:3.5px;height:44px;
  margin:24px 0 4px;width:76%;max-width:300px}
.itc-tk-wave i{flex:1;max-width:6px;min-height:5px;border-radius:3px;
  background:linear-gradient(180deg,#F4A28C,#C45A3C);transform:scaleY(.35);transform-origin:center}
.itc-tk-wave.playing i{animation:itc-eqb 1s ease-in-out infinite}
.itc-tk-wave.playing i:nth-child(4n+1){animation-delay:.1s}
.itc-tk-wave.playing i:nth-child(4n+2){animation-delay:.35s}
.itc-tk-wave.playing i:nth-child(4n+3){animation-delay:.6s}
.itc-tk-wave.playing i:nth-child(4n){animation-delay:.85s}
.itc-tk-badge{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;
  color:#fcd34d;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);
  border-radius:9999px;padding:4px 12px;margin-top:8px}
.itc-tk-actions{display:flex;flex-direction:column;gap:10px;width:100%;max-width:330px;margin-top:26px}
.itc-tk-confirm{width:100%;font-family:inherit;font-size:15.5px;font-weight:700;color:#fff;
  padding:16px;border:0;border-radius:16px;cursor:pointer;
  background:linear-gradient(135deg,#22c55e,#15803d);box-shadow:0 10px 28px rgba(34,197,94,.4);
  transition:transform .16s cubic-bezier(.32,.72,0,1);-webkit-tap-highlight-color:transparent}
.itc-tk-confirm:active{transform:scale(.96)}
.itc-tk-confirm:disabled{opacity:.6}
.itc-tk-play{width:100%;font-family:inherit;font-size:14px;font-weight:700;color:#fff;
  padding:15px;border:0;border-radius:16px;cursor:pointer;
  background:linear-gradient(135deg,#E07A5F,#C45A3C);box-shadow:0 10px 26px rgba(224,122,95,.4);
  transition:transform .16s;-webkit-tap-highlight-color:transparent}
.itc-tk-play:active{transform:scale(.96)}
.itc-tk-ghost{width:100%;font-family:inherit;font-size:13px;font-weight:600;color:#D0D4E0;
  padding:13px;border-radius:16px;cursor:pointer;background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.12);-webkit-tap-highlight-color:transparent}
.itc-tk-later{background:none;border:0;font-family:inherit;font-size:12px;font-weight:600;
  color:#71717a;margin-top:14px;cursor:pointer;padding:6px}
.itc-tk-count{font-size:11px;font-weight:700;color:#AEB2C0;margin-top:6px}
`
