/**
 * Office Live Intercom styles — injected by intercom.tsx alongside the chat
 * panel. Class prefix `itc-` so nothing collides with OFFICE_CSS. Also carries
 * the iOS-sheet upgrade for the chat panel on phones (full-screen sheet with
 * safe-area insets + the iOS spring curve) so the group chat feels native in
 * the WKWebView shell.
 *
 * The visual language mirrors the approved standalone demo
 * (public/office-intercom-demo.html): premium press-and-hold mic with ripple
 * rings, waveform voice bubbles, live per-staff receipt chips with an animated
 * equalizer, and an iOS incoming-call-style full-screen takeover.
 */
export const INTERCOM_CSS = `
/* ═══ iOS full-screen sheet: the chat panel on phones ═══ */
@media (max-width: 680px) {
  .ohub-chatpanel{
    inset:0; right:0; bottom:0; width:100%; max-width:100%;
    height:100%; max-height:100%; border-radius:0; border:0;
    animation:itc-sheet .4s cubic-bezier(.32,.72,0,1);
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

/* stable avatar chips (target pills + receipts) */
.itc-tav{width:22px;height:22px;flex-shrink:0;border-radius:50%;display:grid;place-items:center;
  font-size:10px;font-weight:800;color:#fff;line-height:1;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 1px 3px rgba(0,0,0,.3)}
.itc-tav.all{background:linear-gradient(135deg,#E07A5F,#C45A3C);font-size:11px}
.itc-tav.sm{width:17px;height:17px;font-size:8.5px}

/* ═══ owner PTT dock (inside the chat panel, above the composer) ═══ */
.itc-dock{
  border-top:1px solid rgba(255,255,255,0.07);
  background:linear-gradient(180deg,rgba(28,28,38,.55),rgba(20,20,28,.9));
  backdrop-filter:blur(22px) saturate(1.25);-webkit-backdrop-filter:blur(22px) saturate(1.25);
  padding:12px 14px 14px;
}
.itc-dock-h{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.itc-dock-h .t{font-size:11.5px;font-weight:700;letter-spacing:.02em;color:#F4A28C;display:inline-flex;align-items:center;gap:6px;text-transform:uppercase}
.itc-dock-h .t .dot{width:6px;height:6px;border-radius:50%;background:#ff4d4d;box-shadow:0 0 0 3px rgba(255,77,77,.18);animation:itc-blink 2s ease-in-out infinite}
@keyframes itc-blink{0%,100%{opacity:1}50%{opacity:.35}}
.itc-err{margin-left:auto;font-size:11px;font-weight:600;color:#fca5a5;max-width:58%;text-align:right}

/* target pills — horizontal scroll, iOS segmented feel */
.itc-targets{display:flex;gap:7px;overflow-x:auto;padding:2px 0 6px;margin-bottom:6px;
  -webkit-overflow-scrolling:touch;scrollbar-width:none}
.itc-targets::-webkit-scrollbar{display:none}
.itc-tpill{flex-shrink:0;display:inline-flex;align-items:center;gap:7px;font-family:inherit;
  font-size:12.5px;font-weight:600;padding:6px 13px 6px 6px;border-radius:9999px;
  background:linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0) 70%),#202027;
  border:1px solid rgba(255,255,255,0.08);color:#D0D4E0;cursor:pointer;
  transition:all .2s cubic-bezier(.32,.72,0,1);-webkit-tap-highlight-color:transparent}
.itc-tpill:active{transform:scale(.95)}
.itc-tpill.on{background:rgba(224,122,95,.16);border-color:rgba(224,122,95,.5);color:#F4A28C;
  box-shadow:0 0 0 1px rgba(224,122,95,.22),0 4px 14px rgba(224,122,95,.18)}

/* PTT row: [urgent] [PTT] [call] */
.itc-row{display:flex;align-items:center;gap:12px;margin-top:6px}
.itc-side{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;
  font-family:inherit;font-size:10.5px;font-weight:700;color:#AEB2C0;background:transparent;
  border:0;cursor:pointer;padding:2px;-webkit-tap-highlight-color:transparent;text-decoration:none;min-width:0}
.itc-side .ic{width:50px;height:50px;border-radius:50%;display:grid;place-items:center;font-size:20px;
  background:linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0) 60%),#202027;
  border:1px solid rgba(255,255,255,0.10);box-shadow:0 4px 14px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.08);
  transition:transform .16s}
.itc-side:active .ic{transform:scale(.9)}
.itc-side.urgent .ic{border-color:rgba(239,68,68,.42);background:rgba(239,68,68,.12)}
.itc-side.urgent{color:#fca5a5}
.itc-side.call .ic{border-color:rgba(34,197,94,.42);background:rgba(34,197,94,.12)}
.itc-side.call{color:#6ee7b7}
.itc-side[aria-disabled="true"]{opacity:.4;pointer-events:none}
.itc-side .cap{max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.itc-ptt-wrap{position:relative;flex-shrink:0;width:96px;height:96px;display:grid;place-items:center}
.itc-ptt{position:relative;z-index:2;width:92px;height:92px;border-radius:50%;border:0;cursor:pointer;
  font-family:inherit;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  background:linear-gradient(150deg,#F4A28C,#E07A5F 45%,#C45A3C);
  box-shadow:0 12px 30px rgba(224,122,95,.5),inset 0 2px 0 rgba(255,255,255,.4),inset 0 -6px 14px rgba(0,0,0,.28);
  transition:transform .2s cubic-bezier(.32,.72,0,1),box-shadow .25s,background .25s;
  user-select:none;-webkit-user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent;
  -webkit-touch-callout:none}
.itc-ptt .mic{font-size:27px;filter:drop-shadow(0 2px 5px rgba(0,0,0,.4));pointer-events:none}
.itc-ptt .lbl{font-size:9.5px;font-weight:800;letter-spacing:.03em;opacity:.96;pointer-events:none}
.itc-ptt:disabled{filter:grayscale(.55);opacity:.55}
.itc-ptt.live{transform:scale(1.07);
  background:linear-gradient(150deg,#ff8a7a,#ff4d4d 45%,#c22626);
  box-shadow:0 14px 44px rgba(255,77,77,.62),inset 0 2px 0 rgba(255,255,255,.4),inset 0 -6px 14px rgba(0,0,0,.32)}
.itc-ptt.cancel{background:linear-gradient(150deg,#a1a1aa,#71717a 45%,#52525b);
  box-shadow:0 10px 26px rgba(0,0,0,.42)}
.itc-ring{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(255,77,77,.6);opacity:0;pointer-events:none}
.itc-ptt-wrap.live .itc-ring{animation:itc-ripple 1.5s ease-out infinite}
.itc-ptt-wrap.live .itc-ring:nth-child(2){animation-delay:.5s}
.itc-ptt-wrap.live .itc-ring:nth-child(3){animation-delay:1s}
@keyframes itc-ripple{0%{transform:scale(.9);opacity:.75}100%{transform:scale(1.85);opacity:0}}

/* live status under the row */
.itc-status{display:flex;align-items:center;justify-content:center;gap:9px;margin-top:11px;min-height:22px}
.itc-status .st{font-size:12px;font-weight:600;color:#AEB2C0;text-align:center;line-height:1.35}
.itc-status .st.live{color:#fda4a4;font-weight:700}
.itc-status .st.cancel{color:#fcd34d;font-weight:700}
.itc-status .timer{font-size:12px;font-weight:800;color:#fda4a4;background:rgba(255,77,77,.13);
  border:1px solid rgba(255,77,77,.35);padding:2px 11px;border-radius:9999px;font-variant-numeric:tabular-nums;flex-shrink:0}

/* CSS-only live equalizer (compositor-friendly, no JS per-frame work) */
.itc-eq{display:inline-flex;align-items:center;gap:2.5px;height:16px}
.itc-eq.sm{height:11px;gap:1.5px}
.itc-eq i{width:3px;border-radius:2px;background:currentColor;height:100%;
  animation:itc-eqb 1s ease-in-out infinite;transform-origin:center}
.itc-eq.sm i{width:2.5px}
.itc-eq i:nth-child(1){animation-delay:0s;height:40%}
.itc-eq i:nth-child(2){animation-delay:.15s;height:85%}
.itc-eq i:nth-child(3){animation-delay:.3s;height:60%}
.itc-eq i:nth-child(4){animation-delay:.45s;height:95%}
.itc-eq i:nth-child(5){animation-delay:.6s;height:50%}
@keyframes itc-eqb{0%,100%{transform:scaleY(.42)}50%{transform:scaleY(1.12)}}

/* ═══ voice bubble in the chat feed ═══ */
.itc-vb{min-width:224px;max-width:100%}
.itc-vb .vb-tag{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;
  color:#fda4a4;background:rgba(255,77,77,.10);border:1px solid rgba(255,77,77,.26);
  border-radius:9999px;padding:2.5px 9px;margin-bottom:8px;letter-spacing:.01em}
.itc-vb .vb-row{display:flex;align-items:center;gap:10px}
.itc-vb .vb-play{width:36px;height:36px;border-radius:50%;flex-shrink:0;display:grid;place-items:center;
  font-size:12px;color:#fff;cursor:pointer;border:0;font-family:inherit;
  background:linear-gradient(135deg,#E07A5F,#C45A3C);box-shadow:0 4px 12px rgba(224,122,95,.45),inset 0 1px 0 rgba(255,255,255,.25);
  transition:transform .15s;-webkit-tap-highlight-color:transparent}
.itc-vb .vb-play:active{transform:scale(.9)}
.itc-bars{flex:1;display:flex;align-items:center;gap:2px;height:28px;position:relative;min-width:96px}
.itc-bars i{flex:1;min-width:2px;border-radius:2px;background:rgba(244,162,140,.34)}
.itc-bars .fill{position:absolute;left:0;top:0;bottom:0;display:flex;align-items:center;gap:2px;
  overflow:hidden;pointer-events:none;width:0%;transition:width .12s linear}
.itc-bars .fill i{background:linear-gradient(180deg,#F4A28C,#E07A5F)}
.itc-vb .vb-dur{font-size:11px;color:#AEB2C0;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0}
.itc-vb .vb-tr{margin-top:9px;font-size:12px;line-height:1.5;color:#AEB2C0;
  border-top:1px dashed rgba(255,255,255,0.10);padding-top:8px}
.itc-vb .vb-tr b{color:#6ee7b7;font-weight:600}
.itc-vb .vb-tr.pending{color:#71717a}
.itc-vb .vb-tr.pending b{color:#71717a}

/* receipts (owner view) */
.itc-rcpts{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
.itc-rcpt{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;
  padding:2.5px 9px 2.5px 3px;border-radius:9999px;background:#26262e;
  border:1px solid rgba(255,255,255,0.07);color:#8b8b95;transition:all .3s}
.itc-rcpt .mk{font-size:9.5px;font-weight:700}
.itc-rcpt.delivered{color:#7dd3fc;border-color:rgba(56,189,248,.3);background:rgba(56,189,248,.08)}
.itc-rcpt.played{color:#fcd34d;border-color:rgba(245,158,11,.32);background:rgba(245,158,11,.09)}
.itc-rcpt.confirmed{color:#6ee7b7;border-color:rgba(34,197,94,.34);background:rgba(34,197,94,.10)}

/* staff self-state on a bubble */
.itc-mystate{margin-top:9px}
.itc-confirm-sm{width:100%;font-family:inherit;font-size:12.5px;font-weight:700;color:#fff;
  padding:10px;border:0;border-radius:12px;cursor:pointer;
  background:linear-gradient(135deg,#22c55e,#15803d);box-shadow:0 4px 14px rgba(34,197,94,.35),inset 0 1px 0 rgba(255,255,255,.2);
  transition:transform .15s;-webkit-tap-highlight-color:transparent}
.itc-confirm-sm:active{transform:scale(.97)}
.itc-confirm-sm:disabled{opacity:.6}
.itc-donechip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;
  color:#6ee7b7;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);
  padding:4px 11px;border-radius:9999px}

/* urgent bubble */
.itc-vb.urgent{background:linear-gradient(135deg,rgba(239,68,68,.16),rgba(180,30,30,.10));
  border:1px solid rgba(239,68,68,.34);border-radius:14px;padding:12px 13px}
.itc-vb.urgent .vb-utitle{font-size:13.5px;font-weight:800;color:#fecaca;display:flex;align-items:center;gap:7px}
.itc-vb.urgent .vb-usub{font-size:11.5px;color:rgba(254,202,202,.78);margin-top:3px}

/* ═══ staff full-screen takeover (walkie-talkie) ═══ */
.itc-takeover{position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;align-items:center;
  justify-content:center;text-align:center;
  padding:calc(30px + env(safe-area-inset-top,0px)) 26px calc(30px + env(safe-area-inset-bottom,0px));
  font-family:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;color:#F7F8FC;
  background:radial-gradient(120% 90% at 50% -10%, rgba(224,122,95,.30), transparent 55%),rgba(9,9,14,.97);
  backdrop-filter:blur(28px) saturate(1.2);-webkit-backdrop-filter:blur(28px) saturate(1.2);
  animation:itc-tk .44s cubic-bezier(.32,.72,0,1)}
@keyframes itc-tk{from{opacity:0;transform:scale(1.05)}to{opacity:1;transform:none}}
.itc-takeover.urgent{background:radial-gradient(120% 90% at 50% -10%, rgba(239,68,68,.36), transparent 55%),rgba(14,7,7,.98)}
.itc-tk-av{position:relative;width:108px;height:108px;border-radius:50%;display:grid;place-items:center;
  font-size:40px;font-weight:800;color:#fff;
  background:linear-gradient(135deg,#E07A5F,#C45A3C);
  box-shadow:0 0 0 5px rgba(224,122,95,.26),0 18px 48px rgba(224,122,95,.45)}
.itc-takeover.urgent .itc-tk-av{background:linear-gradient(135deg,#ef4444,#b91c1c);
  box-shadow:0 0 0 5px rgba(239,68,68,.3),0 18px 48px rgba(239,68,68,.4)}
.itc-tk-av .ring{position:absolute;inset:-6px;border-radius:50%;border:2px solid rgba(224,122,95,.55);
  animation:itc-ripple 1.6s ease-out infinite}
.itc-takeover.urgent .itc-tk-av .ring{border-color:rgba(239,68,68,.55)}
.itc-tk-av .ring.r2{animation-delay:.55s}
.itc-tk-kicker{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
  color:#F4A28C;margin-top:24px}
.itc-takeover.urgent .itc-tk-kicker{color:#fca5a5}
.itc-tk-title{font-size:23px;font-weight:800;margin-top:5px;letter-spacing:-.01em}
.itc-tk-sub{font-size:12.5px;color:#AEB2C0;margin-top:6px;max-width:280px}
.itc-tk-wave{display:flex;align-items:center;justify-content:center;gap:3.5px;height:46px;
  margin:26px 0 4px;width:78%;max-width:310px}
.itc-tk-wave i{flex:1;max-width:6px;min-height:5px;border-radius:3px;
  background:linear-gradient(180deg,#F4A28C,#C45A3C);transform:scaleY(.32);transform-origin:center;
  transition:transform .2s}
.itc-tk-wave.playing i{animation:itc-eqb 1s ease-in-out infinite}
.itc-tk-wave.playing i:nth-child(4n+1){animation-delay:.1s}
.itc-tk-wave.playing i:nth-child(4n+2){animation-delay:.35s}
.itc-tk-wave.playing i:nth-child(4n+3){animation-delay:.6s}
.itc-tk-wave.playing i:nth-child(4n){animation-delay:.85s}
.itc-tk-badge{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;
  color:#fcd34d;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);
  border-radius:9999px;padding:4px 13px;margin-top:8px}
.itc-tk-actions{display:flex;flex-direction:column;gap:10px;width:100%;max-width:340px;margin-top:28px}
.itc-tk-confirm{width:100%;font-family:inherit;font-size:15.5px;font-weight:700;color:#fff;
  padding:16px;border:0;border-radius:16px;cursor:pointer;
  background:linear-gradient(135deg,#22c55e,#15803d);box-shadow:0 10px 30px rgba(34,197,94,.42),inset 0 1px 0 rgba(255,255,255,.2);
  transition:transform .16s cubic-bezier(.32,.72,0,1);-webkit-tap-highlight-color:transparent}
.itc-tk-confirm:active{transform:scale(.96)}
.itc-tk-confirm:disabled{opacity:.6}
.itc-tk-play{width:100%;font-family:inherit;font-size:14.5px;font-weight:700;color:#fff;
  padding:15px;border:0;border-radius:16px;cursor:pointer;
  background:linear-gradient(135deg,#E07A5F,#C45A3C);box-shadow:0 10px 28px rgba(224,122,95,.42),inset 0 1px 0 rgba(255,255,255,.22);
  transition:transform .16s;-webkit-tap-highlight-color:transparent}
.itc-tk-play:active{transform:scale(.96)}
.itc-tk-ghost{width:100%;font-family:inherit;font-size:13px;font-weight:600;color:#D0D4E0;
  padding:13px;border-radius:16px;cursor:pointer;background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.12);-webkit-tap-highlight-color:transparent}
.itc-tk-later{background:none;border:0;font-family:inherit;font-size:12px;font-weight:600;
  color:#71717a;margin-top:16px;cursor:pointer;padding:6px}
.itc-tk-count{font-size:11px;font-weight:700;color:#AEB2C0;margin-top:8px}

/* call log line in the chat feed */
.itc-vb.call{background:linear-gradient(135deg,rgba(34,197,94,.10),rgba(16,120,60,.06));
  border:1px solid rgba(34,197,94,.24);border-radius:14px;padding:9px 12px}
.itc-callline{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:#D0D4E0}
.itc-callstat{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:9999px}
.itc-callstat.ok{color:#6ee7b7;background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3)}
.itc-callstat.miss{color:#fca5a5;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3)}

/* ═══ full-screen live-call overlay (incoming ring + active call) ═══ */
.itc-call{position:fixed;inset:0;z-index:95;display:flex;flex-direction:column;align-items:center;
  justify-content:space-between;text-align:center;
  padding:calc(64px + env(safe-area-inset-top,0px)) 28px calc(48px + env(safe-area-inset-bottom,0px));
  font-family:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;color:#F7F8FC;
  background:radial-gradient(120% 80% at 50% -8%, rgba(224,122,95,.28), transparent 55%),rgba(9,9,14,.98);
  backdrop-filter:blur(30px) saturate(1.2);-webkit-backdrop-filter:blur(30px) saturate(1.2);
  animation:itc-tk .4s cubic-bezier(.32,.72,0,1)}
.itc-call.active{background:radial-gradient(120% 80% at 50% -8%, rgba(34,197,94,.20), transparent 55%),rgba(9,9,14,.98)}
.itc-call-top{display:flex;flex-direction:column;align-items:center;gap:0;margin-top:8px}
.itc-call .itc-tk-av{width:118px;height:118px;font-size:44px;margin-bottom:24px}
.itc-call .itc-tk-av.connected{box-shadow:0 0 0 5px rgba(34,197,94,.28),0 18px 48px rgba(34,197,94,.4);
  background:linear-gradient(135deg,#22c55e,#15803d)}
.itc-call-who{font-size:24px;font-weight:800;letter-spacing:-.01em}
.itc-call-sub{font-size:13.5px;color:#AEB2C0;margin-top:8px;display:flex;align-items:center;gap:7px;justify-content:center}
.itc-call-timer{font-size:17px;font-weight:800;color:#6ee7b7;margin-top:14px;font-variant-numeric:tabular-nums;letter-spacing:.03em}
.itc-call-btns{display:flex;gap:72px;margin-bottom:6px}
.itc-cbtn{width:70px;height:70px;border-radius:50%;border:0;font-size:27px;cursor:pointer;color:#fff;
  display:grid;place-items:center;transition:transform .15s;font-family:inherit;-webkit-tap-highlight-color:transparent}
.itc-cbtn:active{transform:scale(.92)}
.itc-cbtn.accept{background:linear-gradient(135deg,#22c55e,#15803d);box-shadow:0 10px 30px rgba(34,197,94,.5);
  animation:itc-cbob 1.2s ease-in-out infinite}
.itc-cbtn.decline{background:linear-gradient(135deg,#ef4444,#b91c1c);box-shadow:0 10px 30px rgba(239,68,68,.45)}
.itc-cbtn.big{width:66px;height:66px}
@keyframes itc-cbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
.itc-call-labels{display:flex;gap:72px;font-size:11.5px;color:#AEB2C0;margin-top:-2px}
.itc-call-labels span{width:70px;text-align:center}
.itc-call-actions{display:flex;flex-direction:column;align-items:center;gap:12px}
.itc-call-mute{font-family:inherit;font-size:13.5px;font-weight:700;color:#F7F8FC;padding:11px 22px;border-radius:9999px;
  cursor:pointer;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);margin-bottom:6px;
  -webkit-tap-highlight-color:transparent}
.itc-call-mute.on{background:rgba(245,158,11,.16);border-color:rgba(245,158,11,.4);color:#fcd34d}
.itc-call-end-lbl{font-size:11.5px;color:#AEB2C0}

@media(prefers-reduced-motion:reduce){
  .itc-eq i,.itc-tk-wave.playing i,.itc-ptt-wrap.live .itc-ring,.itc-tk-av .ring,.itc-dock-h .t .dot,
  .itc-cbtn.accept{animation:none}
}
`
