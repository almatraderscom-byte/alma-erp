/**
 * Office Hub theme — the approved "ALMA Office Hub" dark design, ported verbatim
 * from the design demo and scoped under `.ohub` so none of these semantic class
 * names (.card, .btn, .kpi, .award, …) leak into the live ERP styles.
 *
 * The office surface is a fixed, full-viewport dark world that paints over the
 * ERP sidebar + ambient gradient, exactly like the standalone demo. Keyframes
 * are prefixed `oh-` to avoid collisions with ERP animations.
 */
export const OFFICE_CSS = `
.ohub{
  --accent:#E07A5F; --accent-lt:#F4A28C; --accent-dim:#C45A3C;
  --bg-0:#121216; --bg-1:#1A1A20; --bg-2:#202027; --bg-3:#26262e;
  --ink:#F7F8FC; --muted:#AEB2C0; --muted-hi:#D0D4E0;
  --border:rgba(255,255,255,0.10); --border-subtle:rgba(255,255,255,0.07); --border-strong:rgba(255,255,255,0.16);
  --success:#22c55e; --warning:#f59e0b; --danger:#ef4444; --info:#3b82f6; --violet:#8b5cf6; --sky:#38bdf8;
  --r-sm:12px; --r-md:16px; --r-lg:22px; --r-pill:9999px;
  --shadow:0 6px 30px rgba(0,0,0,0.45);
  --font:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;
  position:fixed; inset:0; z-index:70; overflow-y:auto; overflow-x:hidden;
  font-family:var(--font); background:var(--bg-0); color:var(--ink);
  -webkit-font-smoothing:antialiased; line-height:1.5;
  background-image:
    radial-gradient(900px 500px at 12% -8%, rgba(224,122,95,0.12), transparent 60%),
    radial-gradient(800px 500px at 100% 0%, rgba(139,92,246,0.10), transparent 55%);
}
.ohub *{box-sizing:border-box;margin:0;padding:0}
.ohub::-webkit-scrollbar{width:9px;height:9px}
.ohub::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12);border-radius:9px}
.ohub .num{font-variant-numeric:tabular-nums}

/* ── top perspective switcher ── */
.ohub .topbar{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:14px;
  padding:14px 22px;background:rgba(18,18,22,0.82);backdrop-filter:blur(18px) saturate(1.1);
  border-bottom:1px solid var(--border-subtle)}
.ohub .brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.01em;color:var(--ink);text-decoration:none}
.ohub .brand .logo{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-size:16px;
  background:linear-gradient(135deg,var(--accent),var(--accent-dim));box-shadow:0 4px 14px rgba(224,122,95,.45)}
.ohub .brand small{display:block;font-size:11px;font-weight:500;color:var(--muted)}
.ohub .seg{margin-left:auto;display:flex;gap:4px;padding:4px;background:var(--bg-2);border:1px solid var(--border-subtle);border-radius:var(--r-pill)}
.ohub .seg button{font-family:inherit;font-size:13px;font-weight:600;color:var(--muted);padding:8px 16px;border:0;background:transparent;border-radius:var(--r-pill);cursor:pointer;transition:.18s}
.ohub .seg button.active{background:linear-gradient(135deg,var(--accent),var(--accent-dim));color:#fff;box-shadow:0 3px 12px rgba(224,122,95,.4)}
.ohub .bell{position:relative;flex-shrink:0;width:40px;height:40px;border-radius:var(--r-pill);display:grid;place-items:center;font-size:17px;background:var(--bg-2);border:1px solid var(--border-subtle);color:var(--ink);cursor:pointer}
.ohub .bell .bdot{position:absolute;top:-4px;right:-4px;min-width:19px;height:19px;border-radius:10px;background:var(--danger);color:#fff;font-size:10.5px;font-weight:700;display:grid;place-items:center;padding:0 5px;border:2px solid var(--bg-0)}

.ohub .wrap{max-width:1280px;margin:0 auto;padding:26px 22px 100px}
.ohub .perspective{display:none}
.ohub .perspective.show{display:block;animation:oh-fade .26s ease}
@keyframes oh-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

.ohub .phead{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.ohub .phead .kicker{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.ohub .phead h1{font-size:26px;font-weight:700;letter-spacing:-.02em;margin-top:4px}
.ohub .phead p{color:var(--muted);font-size:14px;margin-top:3px}
.ohub .pill-row{display:flex;gap:8px;flex-wrap:wrap}
.ohub .chip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:var(--r-pill);background:var(--bg-2);border:1px solid var(--border-subtle);color:var(--muted-hi)}
.ohub .chip.live{color:var(--success)} .ohub .chip.live .dot{width:7px;height:7px;border-radius:50%;background:var(--success);box-shadow:0 0 0 4px rgba(34,197,94,.18)}

/* ── KPI cards ── */
.ohub .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}
.ohub .kpi{position:relative;overflow:hidden;background:var(--bg-1);border:1px solid var(--border-subtle);border-radius:var(--r-lg);padding:18px}
.ohub .kpi .ic{font-size:20px}
.ohub .kpi .v{font-size:30px;font-weight:700;letter-spacing:-.02em;margin-top:8px}
.ohub .kpi .l{font-size:13px;color:var(--muted);margin-top:2px}
.ohub .kpi .glow{position:absolute;right:-20px;top:-20px;width:90px;height:90px;border-radius:50%;filter:blur(20px);opacity:.5}
.ohub .kpi.amber .glow{background:var(--warning)} .ohub .kpi.amber .v{color:#fcd34d}
.ohub .kpi.sky .glow{background:var(--sky)} .ohub .kpi.sky .v{color:#7dd3fc}
.ohub .kpi.green .glow{background:var(--success)} .ohub .kpi.green .v{color:#6ee7b7}
.ohub .kpi.violet .glow{background:var(--violet)} .ohub .kpi.violet .v{color:#c4b5fd}

.ohub .grid2{display:grid;grid-template-columns:1.55fr 1fr;gap:18px;align-items:start}
.ohub .section-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.ohub .section-h h2{font-size:16px;font-weight:700}
.ohub .section-h .count{font-size:12px;font-weight:700;color:var(--accent-lt);background:rgba(224,122,95,.12);padding:3px 10px;border-radius:var(--r-pill)}
.ohub .card{background:var(--bg-1);border:1px solid var(--border-subtle);border-radius:var(--r-lg);box-shadow:var(--shadow)}

/* ── approval queue item ── */
.ohub .appr{display:flex;gap:14px;padding:16px;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:.16s}
.ohub .appr:last-child{border-bottom:0}
.ohub .appr:hover{background:var(--bg-2)}
.ohub .thumb{width:64px;height:64px;border-radius:14px;flex-shrink:0;background-size:cover;background-position:center;border:1px solid var(--border)}
.ohub .ph1{background:linear-gradient(135deg,#3a2f4f,#5b3a52)}
.ohub .ph2{background:linear-gradient(135deg,#26404f,#2e5b52)}
.ohub .ph3{background:linear-gradient(135deg,#4a3a26,#5b4a2e)}
.ohub .appr .body{flex:1;min-width:0}
.ohub .appr .top{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.ohub .appr h3{font-size:15px;font-weight:600}
.ohub .appr .meta{font-size:12.5px;color:var(--muted)}
.ohub .appr .actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.ohub .btn{font-family:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:var(--r-pill);border:1px solid var(--border);background:var(--bg-2);color:var(--ink);cursor:pointer;transition:.16s;display:inline-flex;align-items:center;gap:6px}
.ohub .btn:hover{border-color:var(--border-strong)}
.ohub .btn:disabled{opacity:.5;cursor:not-allowed}
.ohub .btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent-dim));border-color:transparent;color:#fff}
.ohub .btn.primary:hover{filter:brightness(1.06)}
.ohub .btn.ghost{background:transparent}
.ohub .btn.danger{color:#fca5a5;border-color:rgba(239,68,68,.3)}
.ohub .btn.sm{font-size:12px;padding:6px 11px}

/* avatars + badges */
.ohub .av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0}
.ohub .av.lg{width:40px;height:40px;font-size:14px}
.ohub .av.e{background:linear-gradient(135deg,#6366f1,#8b5cf6)}
.ohub .av.m{background:linear-gradient(135deg,#0ea5e9,#06b6d4)}
.ohub .av.o{background:linear-gradient(135deg,var(--accent),var(--accent-dim))}
.ohub .av.gray{background:#3f3f46}
.ohub .badge{font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:var(--r-pill);border:1px solid transparent;white-space:nowrap}
.ohub .b-pending{background:rgba(245,158,11,.14);color:#fcd34d;border-color:rgba(245,158,11,.3)}
.ohub .b-active{background:rgba(56,189,248,.14);color:#7dd3fc;border-color:rgba(56,189,248,.3)}
.ohub .b-done{background:rgba(34,197,94,.14);color:#6ee7b7;border-color:rgba(34,197,94,.3)}
.ohub .b-redo{background:rgba(239,68,68,.14);color:#fca5a5;border-color:rgba(239,68,68,.3)}
.ohub .b-carry{background:rgba(139,92,246,.14);color:#c4b5fd;border-color:rgba(139,92,246,.3)}
.ohub .b-overdue{background:rgba(239,68,68,.18);color:#fca5a5;border-color:rgba(239,68,68,.42)}

/* deadline (owner board) */
.ohub .due-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px}
.ohub .due-chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:#cbd5e1;background:rgba(148,163,184,.12);border:1px solid rgba(148,163,184,.22);padding:4px 10px;border-radius:var(--r-pill)}
.ohub .due-chip.over{color:#fca5a5;background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.32)}
.ohub .due-chip.none{color:var(--muted);background:transparent;border-style:dashed}
.ohub .due-edit{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px}
.ohub .due-edit input[type="datetime-local"]{font-size:13px;color:var(--ink);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-pill);padding:7px 11px;color-scheme:dark}

/* deadline (staff card) */
.ohub .due-staff{font-size:12.5px;font-weight:600;color:#cbd5e1;margin-top:6px}
.ohub .due-staff.over{color:#fca5a5}

/* staff status board */
.ohub .staff-row{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border-subtle)}
.ohub .staff-row:last-child{border-bottom:0}
.ohub .staff-row .info{flex:1;min-width:0}
.ohub .staff-row .name{font-size:14.5px;font-weight:600;display:flex;align-items:center;gap:7px}
.ohub .staff-row .sub{font-size:12.5px;color:var(--muted)}
.ohub .dotmini{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.ohub .on{background:var(--success);box-shadow:0 0 0 3px rgba(34,197,94,.18)}
.ohub .lunch{background:var(--warning);box-shadow:0 0 0 3px rgba(245,158,11,.18)}
.ohub .off{background:var(--muted)}

/* activity feed */
.ohub .feed{padding:6px 4px}
.ohub .ev{display:flex;gap:12px;padding:11px 14px;position:relative}
.ohub .ev .tl{display:flex;flex-direction:column;align-items:center}
.ohub .ev .ic{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:12px;background:var(--bg-2);border:1px solid var(--border)}
.ohub .ev .line{flex:1;width:2px;background:var(--border-subtle);margin-top:2px}
.ohub .ev:last-child .line{display:none}
.ohub .ev .txt{font-size:13px;padding-bottom:6px}
.ohub .ev .txt b{font-weight:600}
.ohub .ev .t{font-size:11.5px;color:var(--muted);margin-top:2px}

/* ── thread / task detail ── */
.ohub .thread-head{padding:20px;border-bottom:1px solid var(--border-subtle)}
.ohub .thread-head .crumb{font-size:12.5px;color:var(--muted);margin-bottom:8px;cursor:pointer}
.ohub .thread-head h2{font-size:19px;font-weight:700;letter-spacing:-.01em}
.ohub .thread-head .row{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
.ohub .instr{margin:14px 20px;background:var(--bg-2);border:1px solid var(--border-subtle);border-radius:var(--r-md);padding:14px}
.ohub .instr .h{font-size:12px;font-weight:700;color:var(--accent-lt);margin-bottom:6px}
.ohub .instr p{font-size:13.5px;color:var(--muted-hi);white-space:pre-line}

.ohub .msgs{padding:6px 20px}
.ohub .msg{display:flex;gap:12px;padding:12px 0}
.ohub .msg .bubble{flex:1;min-width:0}
.ohub .msg .mh{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.ohub .msg .mh .nm{font-size:13.5px;font-weight:600}
.ohub .msg .mh .tm{font-size:11.5px;color:var(--muted)}
.ohub .msg .content{font-size:13.5px;color:var(--muted-hi);background:var(--bg-2);border:1px solid var(--border-subtle);border-radius:4px 16px 16px 16px;padding:11px 14px;white-space:pre-line}
.ohub .msg.owner .content{background:rgba(224,122,95,.10);border-color:rgba(224,122,95,.25);color:var(--ink)}
.ohub .msg.agent .content{background:rgba(16,185,129,.10);border-color:rgba(16,185,129,.26)}
.ohub .msg .proof{margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ohub .msg .proof .pimg{width:120px;height:90px;border-radius:12px;background-size:cover;background-position:center;border:1px solid var(--border)}
.ohub .sysline{text-align:center;font-size:11.5px;color:var(--muted);padding:8px 0;position:relative}
.ohub .sysline span{background:var(--bg-1);padding:0 12px;position:relative;z-index:1}
.ohub .sysline:before{content:"";position:absolute;left:20px;right:20px;top:50%;height:1px;background:var(--border-subtle)}

.ohub .composer{padding:14px 20px;border-top:1px solid var(--border-subtle);background:var(--bg-2);border-radius:0 0 var(--r-lg) var(--r-lg)}
.ohub .composer .ibox{display:flex;gap:10px;align-items:center;background:var(--bg-0);border:1px solid var(--border);border-radius:var(--r-pill);padding:6px 6px 6px 16px}
.ohub .composer input{flex:1;background:transparent;border:0;color:var(--ink);font-family:inherit;font-size:13.5px;outline:none}
.ohub .composer .owner-actions{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.ohub .composer .owner-actions .btn{flex:1;justify-content:center;padding:11px}

/* ── staff mobile frame ── */
.ohub .stage{display:flex;justify-content:center;gap:40px;flex-wrap:wrap}
.ohub .phone{width:380px;max-width:100%;height:780px;background:var(--bg-0);border:10px solid #2a2a31;border-radius:46px;box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden;position:relative;display:flex;flex-direction:column}
.ohub .phone .notch{position:absolute;top:0;left:50%;transform:translateX(-50%);width:150px;height:28px;background:#2a2a31;border-radius:0 0 18px 18px;z-index:30}
.ohub .pscreen{flex:1;overflow-y:auto;padding:42px 16px 90px}
.ohub .pscreen::-webkit-scrollbar{display:none}
.ohub .stitle{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}
.ohub .sh1{font-size:22px;font-weight:700;margin-top:3px;margin-bottom:2px}
.ohub .ssub{font-size:13px;color:var(--muted);margin-bottom:18px}
.ohub .stask{background:var(--bg-1);border:1px solid var(--border-subtle);border-radius:var(--r-md);padding:14px;margin-bottom:12px;cursor:pointer;transition:.16s}
.ohub .stask:hover{border-color:var(--border-strong);transform:translateY(-1px)}
.ohub .stask .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.ohub .stask h4{font-size:14.5px;font-weight:600;line-height:1.35}
.ohub .stask .d{font-size:12.5px;color:var(--muted);margin-top:7px}
.ohub .stask .ntf{display:inline-flex;align-items:center;gap:5px;margin-top:9px;font-size:12px;font-weight:600;color:#fca5a5;background:rgba(239,68,68,.1);padding:4px 9px;border-radius:var(--r-pill)}
.ohub .pnav{position:absolute;bottom:0;left:0;right:0;height:74px;background:rgba(18,18,22,.92);backdrop-filter:blur(16px);border-top:1px solid var(--border-subtle);display:flex;align-items:flex-start;justify-content:space-around;padding-top:11px;z-index:20}
.ohub .pnav a{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:10.5px;color:var(--muted);text-decoration:none}
.ohub .pnav a.act{color:var(--accent-lt)}
.ohub .pnav a .i{font-size:19px}
.ohub .backbtn{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);background:none;border:0;cursor:pointer;font-family:inherit;margin-bottom:14px}
.ohub .perf{display:flex;gap:10px;margin-top:6px}
.ohub .perf .pc{flex:1;background:var(--bg-1);border:1px solid var(--border-subtle);border-radius:14px;padding:13px;text-align:center}
.ohub .perf .pc .v{font-size:22px;font-weight:700} .ohub .perf .pc .l{font-size:11.5px;color:var(--muted);margin-top:2px}
.ohub .bar{height:7px;border-radius:9px;background:var(--bg-3);overflow:hidden;margin-top:8px}
.ohub .bar i{display:block;height:100%;border-radius:9px;background:linear-gradient(90deg,var(--accent),var(--accent-lt))}

.ohub .note{display:flex;gap:10px;background:rgba(224,122,95,.08);border:1px solid rgba(224,122,95,.2);border-radius:var(--r-md);padding:13px 15px;margin-top:18px;font-size:13px;color:var(--muted-hi)}
.ohub .note .i{font-size:17px}
.ohub .hidden{display:none!important}
@media(max-width:960px){.ohub .kpis{grid-template-columns:repeat(2,1fr)}.ohub .grid2{grid-template-columns:1fr}}
@media(max-width:680px){
  .ohub .wrap{padding:18px 14px 100px}
  .ohub .topbar{padding:11px 14px;flex-wrap:wrap;gap:10px}
  .ohub .brand small{display:none}
  .ohub .seg button{padding:7px 12px;font-size:12.5px}
  .ohub .phead h1{font-size:21px}
  .ohub .kpi{padding:14px} .ohub .kpi .v{font-size:24px}
  .ohub .stage{gap:22px}
  .ohub .phone{width:100%;max-width:420px;height:auto;min-height:560px;border-radius:34px}
  .ohub .pscreen{padding:24px 14px 30px}
  .ohub .pnav{display:none}
  .ohub .award{padding:18px} .ohub .award .inner{gap:16px} .ohub h2.aw{font-size:21px}
  .ohub .photo{width:78px;height:78px;font-size:28px}
  .ohub .award .stats{gap:14px}
}

/* ════ update tracking (no-response) ════ */
.ohub .track{border-radius:var(--r-lg);margin-bottom:22px;overflow:hidden;
  background:linear-gradient(135deg,rgba(245,158,11,.10),rgba(239,68,68,.07));border:1px solid rgba(245,158,11,.32)}
.ohub .track-h{display:flex;align-items:center;gap:10px;padding:14px 18px;font-size:15px;font-weight:700;color:#fcd34d;border-bottom:1px solid rgba(245,158,11,.2)}
.ohub .track-h .c{margin-left:auto;font-size:12px;font-weight:700;background:rgba(245,158,11,.18);color:#fcd34d;padding:3px 11px;border-radius:var(--r-pill)}
.ohub .trow{display:flex;align-items:flex-start;gap:13px;padding:14px 18px;border-bottom:1px solid rgba(245,158,11,.12)}
.ohub .trow:last-child{border-bottom:0}
.ohub .trow .info{flex:1;min-width:0}
.ohub .trow .nm{font-size:14.5px;font-weight:600}
.ohub .trow .meta{font-size:12.5px;color:var(--muted);margin-top:3px}
.ohub .trow .esc{font-size:12px;font-weight:600;color:#fca5a5;margin-top:6px;display:inline-flex;align-items:center;gap:6px}
.ohub .trow .acts{display:flex;gap:7px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}

/* staff-side update alert */
.ohub .alert{display:flex;flex-direction:column;gap:9px;border-radius:var(--r-md);padding:14px;margin-bottom:16px;
  background:linear-gradient(135deg,rgba(245,158,11,.13),rgba(239,68,68,.10));border:1px solid rgba(245,158,11,.42)}
.ohub .alert .t{font-size:13.5px;font-weight:700;color:#fcd34d;display:flex;gap:7px;align-items:center}
.ohub .alert .d{font-size:12.5px;color:var(--muted-hi)}
.ohub .alert .cd{font-size:12px;font-weight:700;color:#fca5a5;display:flex;align-items:center;gap:6px}

/* ════ Performer of the Week — award ════ */
.ohub .award{position:relative;overflow:hidden;border-radius:var(--r-lg);padding:24px;margin-bottom:22px;
  background:radial-gradient(130% 150% at 50% -25%, rgba(255,214,120,.22), transparent 58%),
    linear-gradient(135deg,#1d1708,#251c0a 42%,#191306);
  border:1px solid rgba(255,200,90,.38);
  box-shadow:0 12px 44px rgba(150,105,20,.28), inset 0 0 0 1px rgba(255,215,120,.10)}
.ohub .award:after{content:"";position:absolute;inset:0;z-index:2;pointer-events:none;
  background:linear-gradient(115deg,transparent 32%,rgba(255,244,210,.12) 48%,transparent 62%);
  transform:translateX(-110%);animation:oh-shimmer 5s ease-in-out infinite}
@keyframes oh-shimmer{0%,55%{transform:translateX(-110%)}100%{transform:translateX(110%)}}
.ohub .award .inner{position:relative;z-index:3;display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.ohub .crownwrap{position:relative;flex-shrink:0;padding-top:8px}
.ohub .crown{position:absolute;top:-10px;left:50%;transform:translateX(-50%) rotate(-8deg);font-size:30px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.55));animation:oh-bob 3s ease-in-out infinite}
@keyframes oh-bob{0%,100%{transform:translateX(-50%) rotate(-8deg) translateY(0)}50%{transform:translateX(-50%) rotate(-8deg) translateY(-4px)}}
.ohub .photo{width:96px;height:96px;border-radius:50%;display:grid;place-items:center;font-size:36px;font-weight:800;color:#3a2a05;
  background:linear-gradient(135deg,#ffe79a,#f3b13a);
  box-shadow:0 0 0 4px rgba(255,200,90,.4),0 0 0 9px rgba(255,200,90,.14),0 12px 32px rgba(170,115,20,.45)}
.ohub .award .meta{flex:1;min-width:210px}
.ohub .award .tag{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;letter-spacing:.05em;
  color:#ffd97a;background:rgba(255,200,90,.13);border:1px solid rgba(255,200,90,.32);padding:5px 13px;border-radius:var(--r-pill)}
.ohub h2.aw{font-size:25px;font-weight:800;letter-spacing:-.01em;margin:11px 0 3px;
  background:linear-gradient(90deg,#fff,#ffe6ad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ohub .award .sub{font-size:13.5px;color:#d9ca9c}
.ohub .award .stats{display:flex;gap:22px;margin-top:13px;flex-wrap:wrap}
.ohub .award .stats .s b{display:block;font-size:20px;font-weight:700;color:#ffe6ad}
.ohub .award .stats .s span{font-size:11.5px;color:#bca978}
.ohub .ownerctl{position:absolute;top:14px;right:14px;z-index:4}
.ohub .confetti{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1}
.ohub .confetti i{position:absolute;top:-14px;width:8px;height:13px;border-radius:2px;opacity:.92;animation:oh-fall linear infinite}
@keyframes oh-fall{0%{transform:translateY(-16px) rotate(0);opacity:0}10%{opacity:.95}100%{transform:translateY(420px) rotate(560deg);opacity:.9}}

/* compact award for staff phone */
.ohub .award-mini{position:relative;overflow:hidden;border-radius:var(--r-md);padding:14px;margin-bottom:16px;
  background:radial-gradient(120% 130% at 50% -20%, rgba(255,214,120,.22), transparent 60%),linear-gradient(135deg,#1d1708,#191306);
  border:1px solid rgba(255,200,90,.36)}
.ohub .award-mini .inner{position:relative;z-index:3;display:flex;align-items:center;gap:13px}
.ohub .award-mini .photo{width:54px;height:54px;font-size:20px;box-shadow:0 0 0 3px rgba(255,200,90,.4),0 6px 18px rgba(170,115,20,.4)}
.ohub .award-mini .tag{font-size:10.5px;padding:3px 9px}
.ohub .award-mini h3{font-size:15px;font-weight:800;color:#ffe6ad;margin-top:5px}
.ohub .award-mini .sub{font-size:11.5px;color:#cdbd90;margin-top:1px}

/* ════ weekly performance leaderboard ════ */
.ohub .lead{display:flex;align-items:center;gap:13px;padding:13px 16px;border-bottom:1px solid var(--border-subtle)}
.ohub .lead:last-child{border-bottom:0}
.ohub .lead .rank{width:26px;text-align:center;font-size:15px;font-weight:800;color:var(--muted)}
.ohub .lead.top .rank{color:#ffd97a}
.ohub .lead .info{flex:1;min-width:0} .ohub .lead .nm{font-size:14px;font-weight:600;display:flex;align-items:center;gap:7px}
.ohub .lead .ln{margin-top:7px}
.ohub .lead .score{font-size:15px;font-weight:700} .ohub .lead.top .score{color:#ffe6ad}
.ohub .pick{font-size:11px;font-weight:700;color:#ffd97a;background:rgba(255,200,90,.12);border:1px solid rgba(255,200,90,.3);padding:3px 9px;border-radius:var(--r-pill)}

/* ════ self-initiated work ════ */
.ohub .selfbtn{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;font-family:inherit;font-size:13.5px;font-weight:600;
  padding:13px;border-radius:var(--r-md);border:1px dashed rgba(224,122,95,.5);background:rgba(224,122,95,.07);color:var(--accent-lt);cursor:pointer;margin-bottom:14px}
.ohub .self-badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:var(--r-pill);background:rgba(139,92,246,.16);color:#c4b5fd;border:1px solid rgba(139,92,246,.3)}

/* ════ messenger-style chat head + group popup ════ */
.ohub-chathead{position:fixed;right:20px;bottom:24px;z-index:80;display:flex;align-items:center;gap:9px;cursor:pointer;
  padding:12px 18px 12px 14px;border-radius:9999px;font-family:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;font-weight:700;font-size:14px;color:#fff;border:2px solid rgba(255,255,255,.2);
  background:linear-gradient(135deg,#E07A5F,#C45A3C);box-shadow:0 12px 32px rgba(224,122,95,.6);
  user-select:none;animation:oh-bob2 3s ease-in-out infinite}
@keyframes oh-bob2{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.ohub-chathead .em{font-size:22px}
.ohub-chathead .ring{position:absolute;left:8px;width:42px;height:42px;border-radius:50%;border:2px solid rgba(255,255,255,.5);animation:oh-pulse 2.2s ease-out infinite;pointer-events:none}
@keyframes oh-pulse{0%{transform:scale(.8);opacity:.7}100%{transform:scale(1.7);opacity:0}}
.ohub-chathead .badge2{position:absolute;top:-6px;right:-6px;min-width:22px;height:22px;border-radius:11px;background:#ef4444;
  color:#fff;font-size:11.5px;font-weight:700;display:grid;place-items:center;padding:0 6px;border:2px solid #121216}
.ohub-chatpanel{position:fixed;right:20px;bottom:90px;z-index:81;width:384px;max-width:calc(100vw - 28px);height:540px;max-height:74vh;
  font-family:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;color:#F7F8FC;
  background:#1A1A20;border:1px solid rgba(255,255,255,0.10);border-radius:22px;box-shadow:0 26px 74px rgba(0,0,0,.62);
  display:flex;flex-direction:column;overflow:hidden;animation:oh-cpop .2s ease}
@keyframes oh-cpop{from{opacity:0;transform:scale(.93) translateY(12px)}to{opacity:1;transform:none}}
.ohub-chatpanel .cp-head{display:flex;align-items:center;gap:11px;padding:13px 15px;border-bottom:1px solid rgba(255,255,255,0.07);background:#202027}
.ohub-chatpanel .cp-head .gav{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-size:17px;background:linear-gradient(135deg,#10b981,#059669);color:#fff}
.ohub-chatpanel .cp-head .ttl{flex:1;min-width:0} .ohub-chatpanel .cp-head .ttl b{font-size:14.5px;font-weight:700} .ohub-chatpanel .cp-head .ttl span{display:block;font-size:11.5px;color:#22c55e}
.ohub-chatpanel .cp-head .x{background:none;border:0;color:#AEB2C0;font-size:20px;cursor:pointer;padding:2px 6px}
.ohub-chatpanel .cp-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:13px}
.ohub-chatpanel .gm{display:flex;gap:9px;max-width:90%}
.ohub-chatpanel .gm .av{width:27px;height:27px;font-size:11px;margin-top:2px;border-radius:50%;display:grid;place-items:center;color:#fff;flex-shrink:0;background:#3f3f46}
.ohub-chatpanel .gm .av.e{background:linear-gradient(135deg,#6366f1,#8b5cf6)}
.ohub-chatpanel .gm .av.o{background:linear-gradient(135deg,#E07A5F,#C45A3C)}
.ohub-chatpanel .gm .nmt{font-size:11px;color:#AEB2C0;margin-bottom:3px;font-weight:600}
.ohub-chatpanel .gm .gb{background:#202027;border:1px solid rgba(255,255,255,0.07);border-radius:4px 14px 14px 14px;padding:9px 12px;font-size:13px;color:#D0D4E0;white-space:pre-line}
.ohub-chatpanel .gm.me{margin-left:auto;flex-direction:row-reverse}
.ohub-chatpanel .gm.me .gb{background:rgba(224,122,95,.13);border-color:rgba(224,122,95,.26);border-radius:14px 4px 14px 14px;color:#F7F8FC}
.ohub-chatpanel .gm.agent .av{background:linear-gradient(135deg,#10b981,#059669)}
.ohub-chatpanel .gm.agent .gb{background:rgba(16,185,129,.10);border-color:rgba(16,185,129,.26)}
.ohub-chatpanel .gm.draft .gb{background:rgba(245,158,11,.10);border-color:rgba(245,158,11,.30);border-style:dashed}
.ohub-chatpanel .gm.draft .nmt .dtag{margin-left:6px;font-size:10px;font-weight:600;color:#f59e0b;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);border-radius:9999px;padding:1px 7px}
.ohub-chatpanel .gm.draft .dedit{width:100%;min-width:210px;background:#121216;border:1px solid rgba(245,158,11,.35);border-radius:10px;padding:8px 11px;color:#F7F8FC;font-family:inherit;font-size:13px;outline:none;resize:vertical}
.ohub-chatpanel .gm.draft .dact{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}
.ohub-chatpanel .gm.draft .dact button{font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:9999px;border:0;cursor:pointer}
.ohub-chatpanel .gm.draft .dact button:disabled{opacity:.5;cursor:not-allowed}
.ohub-chatpanel .gm.draft .dact .ap{background:linear-gradient(135deg,#10b981,#059669);color:#fff}
.ohub-chatpanel .gm.draft .dact .ed{background:rgba(255,255,255,.07);color:#D0D4E0;border:1px solid rgba(255,255,255,.12)}
.ohub-chatpanel .gm.draft .dact .ds{background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.3)}
.ohub-chatpanel .gsys{text-align:center;font-size:11px;color:#AEB2C0}
.ohub-chatpanel .cp-foot{padding:10px 12px;border-top:1px solid rgba(255,255,255,0.07);background:#202027;display:flex;gap:8px;align-items:center}
.ohub-chatpanel .cp-foot input{flex:1;background:#121216;border:1px solid rgba(255,255,255,0.10);border-radius:9999px;padding:9px 14px;color:#F7F8FC;font-family:inherit;font-size:13px;outline:none}
.ohub-chatpanel .cp-foot button{font-family:inherit;font-size:13px;font-weight:600;padding:9px 14px;border-radius:9999px;border:0;background:linear-gradient(135deg,#E07A5F,#C45A3C);color:#fff;cursor:pointer}
.ohub-chatpanel .cp-foot button:disabled{opacity:.5;cursor:not-allowed}
@media(max-width:480px){.ohub-chatpanel{right:14px;left:14px;bottom:90px;width:auto}}

/* notification dropdown (anchored to topbar bell) */
.ohub-notif{position:fixed;z-index:82;top:64px;right:20px;width:330px;max-width:calc(100vw - 28px);
  font-family:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;color:#F7F8FC;
  background:#1A1A20;border:1px solid rgba(255,255,255,0.12);border-radius:18px;box-shadow:0 26px 74px rgba(0,0,0,.62);overflow:hidden}
.ohub-notif .nh{display:flex;align-items:center;justify-content:space-between;padding:12px 15px;border-bottom:1px solid rgba(255,255,255,0.07)}
.ohub-notif .nh b{font-size:14px;font-weight:700}
.ohub-notif .nh button{background:none;border:0;color:#7dd3fc;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.ohub-notif .nlist{max-height:60vh;overflow-y:auto}
.ohub-notif .ni{display:flex;gap:10px;width:100%;text-align:left;padding:11px 15px;border:0;border-bottom:1px solid rgba(255,255,255,0.05);background:transparent;color:inherit;cursor:pointer;font-family:inherit}
.ohub-notif .ni.unread{background:rgba(56,189,248,.06)}
.ohub-notif .ni .ic{font-size:16px;margin-top:1px}
.ohub-notif .ni .nm{font-size:13px;font-weight:600;line-height:1.35}
.ohub-notif .ni .nb{font-size:11.5px;color:#AEB2C0;margin-top:2px}
.ohub-notif .ni .nt{font-size:11px;color:#AEB2C0;margin-top:2px}
.ohub-notif .nempty{padding:26px 15px;text-align:center;font-size:13px;color:#AEB2C0}

/* ════ header icon buttons (nav toggle + history) ════ */
.ohub .tbtn{flex-shrink:0;height:40px;min-width:40px;padding:0 12px;border-radius:var(--r-pill);display:inline-flex;align-items:center;justify-content:center;gap:7px;
  font-family:inherit;font-size:13px;font-weight:600;background:var(--bg-2);border:1px solid var(--border-subtle);color:var(--ink);cursor:pointer;transition:.16s}
.ohub .tbtn:hover{border-color:var(--border-strong)}
.ohub .tbtn .tic{font-size:17px;line-height:1}
.ohub .tbtn .tlbl{display:inline}
@media(max-width:680px){.ohub .tbtn .tlbl{display:none}.ohub .tbtn{padding:0 11px}}

/* ════ ERP nav drawer (slide-in from left) ════ */
.ohub-drawer-ov{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);animation:oh-fade .2s ease}
.ohub-drawer{position:fixed;top:0;left:0;bottom:0;z-index:91;width:280px;max-width:86vw;display:flex;flex-direction:column;
  font-family:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;color:#F7F8FC;
  background:#16161b;border-right:1px solid rgba(255,255,255,0.08);box-shadow:0 0 70px rgba(0,0,0,.7);animation:oh-slidein .24s cubic-bezier(.2,.8,.2,1)}
@keyframes oh-slidein{from{transform:translateX(-100%)}to{transform:none}}
.ohub-drawer .dh{display:flex;align-items:center;gap:11px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,0.07)}
.ohub-drawer .dh .logo{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:17px;background:linear-gradient(135deg,#E07A5F,#C45A3C);box-shadow:0 4px 14px rgba(224,122,95,.45)}
.ohub-drawer .dh .ttl{flex:1;min-width:0}
.ohub-drawer .dh .ttl b{display:block;font-size:13px;font-weight:800;letter-spacing:.04em;color:#F4A28C}
.ohub-drawer .dh .ttl span{display:block;font-size:10.5px;color:#AEB2C0;margin-top:1px}
.ohub-drawer .dh .x{background:none;border:0;color:#AEB2C0;font-size:22px;cursor:pointer;padding:0 4px;line-height:1}
.ohub-drawer .dnav{flex:1;overflow-y:auto;padding:10px 8px;display:flex;flex-direction:column;gap:2px}
.ohub-drawer .dnav::-webkit-scrollbar{width:7px}
.ohub-drawer .dnav::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12);border-radius:7px}
.ohub-drawer .dl{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:12px;text-decoration:none;color:#D0D4E0;
  border:1px solid transparent;transition:.14s}
.ohub-drawer .dl:hover{background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.08);color:#fff}
.ohub-drawer .dl.cur{background:linear-gradient(90deg,rgba(224,122,95,.22),transparent);border-color:rgba(224,122,95,.4);color:#F4A28C}
.ohub-drawer .dl .di{font-size:17px;width:24px;text-align:center;flex-shrink:0}
.ohub-drawer .dl .dt{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ohub-drawer .dft{padding:12px 14px;border-top:1px solid rgba(255,255,255,0.07);font-size:11px;color:#AEB2C0}

/* ════ day-end history archive ════ */
.ohub-hist-ov{position:fixed;inset:0;z-index:92;background:rgba(0,0,0,.6);backdrop-filter:blur(3px);
  display:flex;justify-content:center;align-items:flex-start;padding:34px 16px 60px;overflow-y:auto;animation:oh-fade .2s ease;
  font-family:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;color:#F7F8FC}
.ohub-hist{width:100%;max-width:900px;background:#1A1A20;border:1px solid rgba(255,255,255,0.08);border-radius:22px;box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden}
.ohub-hist .hh{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.07);background:#202027;position:sticky;top:0;z-index:2}
.ohub-hist .hh .hic{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-size:18px;background:linear-gradient(135deg,#8b5cf6,#6366f1);color:#fff;flex-shrink:0}
.ohub-hist .hh .ttl{flex:1;min-width:0} .ohub-hist .hh .ttl b{font-size:15.5px;font-weight:700} .ohub-hist .hh .ttl span{display:block;font-size:12px;color:#AEB2C0}
.ohub-hist .hh .x{background:none;border:0;color:#AEB2C0;font-size:24px;cursor:pointer;padding:0 6px;line-height:1}
.ohub-hist .hh .back{font-family:inherit;font-size:12.5px;font-weight:600;color:#D0D4E0;background:#26262e;border:1px solid rgba(255,255,255,0.10);border-radius:9999px;padding:7px 13px;cursor:pointer}
.ohub-hist .hbody{padding:16px 20px;max-height:none}
.ohub-hist .hloading{padding:50px 20px;text-align:center;color:#AEB2C0;font-size:13.5px}
/* index: list of days */
.ohub-hist .hday{display:flex;align-items:center;gap:14px;width:100%;text-align:left;padding:14px 16px;margin-bottom:10px;
  background:#202027;border:1px solid rgba(255,255,255,0.07);border-radius:16px;color:inherit;cursor:pointer;font-family:inherit;transition:.16s}
.ohub-hist .hday:hover{border-color:rgba(224,122,95,.4);transform:translateY(-1px)}
.ohub-hist .hday .cal{width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:20px;background:#26262e;border:1px solid rgba(255,255,255,0.08);flex-shrink:0}
.ohub-hist .hday .info{flex:1;min-width:0}
.ohub-hist .hday .dt{font-size:14.5px;font-weight:700}
.ohub-hist .hday .sub{font-size:12.5px;color:#AEB2C0;margin-top:3px}
.ohub-hist .hday .arr{color:#AEB2C0;font-size:18px}
.ohub-hist .hempty{padding:50px 20px;text-align:center;color:#AEB2C0;font-size:13.5px}
/* day board: reuse kpi + stask cards */
.ohub-hist .hk{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.ohub-hist .hk .c{background:#202027;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:13px;text-align:center}
.ohub-hist .hk .c .v{font-size:23px;font-weight:700} .ohub-hist .hk .c .l{font-size:11px;color:#AEB2C0;margin-top:2px}
.ohub-hist .hsec{font-size:13px;font-weight:700;color:#D0D4E0;margin:18px 0 10px}
.ohub-hist .hstaff{display:flex;align-items:center;gap:11px;padding:11px 13px;border-bottom:1px solid rgba(255,255,255,0.06)}
.ohub-hist .hstaff:last-child{border-bottom:0}
.ohub-hist .hstaff .nm{flex:1;font-size:13.5px;font-weight:600}
.ohub-hist .hstaff .ct{font-size:12.5px;color:#AEB2C0}
.ohub-hist .htask{background:#202027;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:13px;margin-bottom:9px}
.ohub-hist .htask .tp{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.ohub-hist .htask h4{font-size:14px;font-weight:600;line-height:1.35}
.ohub-hist .htask .d{font-size:12px;color:#AEB2C0;margin-top:6px}
@media(max-width:680px){.ohub-hist .hk{grid-template-columns:repeat(2,1fr)}}

/* ════ responsive polish for staff phone view on real devices ════ */
@media(max-width:680px){
  .ohub .topbar{position:sticky}
  .ohub .grid2{gap:14px}
  .ohub .appr{padding:13px;gap:11px}
  .ohub .thumb{width:54px;height:54px}
  .ohub .award .stats{gap:16px}
  .ohub .award h2.aw,.ohub h2.aw{font-size:20px}
  .ohub-drawer{width:84vw}
}
/* ── real staff app: a clean responsive column (NOT a phone mockup) ──
   Works full-width on a phone and as a centred card on a PC; grows with
   content instead of the fixed-height device frame used in the old demo. */
.ohub .staffapp{width:100%;max-width:560px;margin:0 auto}
.ohub .sscreen{padding:8px 6px 30px}
@media(max-width:560px){.ohub .sscreen{padding:4px 2px 24px}}

/* ════ profile-photo avatars (real ERP images) ════ */
.ohub .av.img{background-size:cover;background-position:center;background-repeat:no-repeat;color:transparent}
.ohub .photo.img{background-size:cover;background-position:center;background-repeat:no-repeat;font-size:0}
.ohub a.btn{text-decoration:none}

/* ════ owner hero row: performer + daily motivation (req 4) ════ */
.ohub .hero-row{display:flex;gap:18px;align-items:stretch;margin-bottom:22px}
.ohub .hero-row .award{flex:2 1 360px;margin-bottom:0}
.ohub .hero-row .motiv{flex:1 1 250px}
@media(max-width:820px){.ohub .hero-row{flex-direction:column}}

/* ════ daily motivation card (req 4) ════ */
.ohub .motiv{position:relative;overflow:hidden;border-radius:var(--r-lg);padding:22px;display:flex;flex-direction:column;justify-content:center;gap:8px;
  background:radial-gradient(120% 130% at 100% 0%, rgba(124,58,237,.30), transparent 55%),linear-gradient(135deg,#171327,#120f1f);
  border:1px solid rgba(139,92,246,.34)}
.ohub .motiv-glow{position:absolute;right:-30px;top:-30px;width:130px;height:130px;border-radius:50%;
  background:radial-gradient(circle,rgba(139,92,246,.5),transparent 70%);filter:blur(22px);animation:oh-motiv-glow 5s ease-in-out infinite}
.ohub .motiv-tag{position:relative;z-index:2;font-size:12px;font-weight:700;letter-spacing:.05em;color:#c4b5fd}
.ohub .motiv-quote{position:relative;z-index:2;font-size:18px;font-weight:700;line-height:1.55;
  background:linear-gradient(90deg,#e9d5ff,#fbcfe8,#bfdbfe,#e9d5ff);background-size:300% 100%;
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:#f3f0ff;
  animation:oh-motiv-shine 9s linear infinite}
.ohub .motiv-foot{position:relative;z-index:2;font-size:12.5px;color:#a78bce}
@keyframes oh-motiv-glow{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:.95;transform:scale(1.16)}}
@keyframes oh-motiv-shine{0%{background-position:0% 0}100%{background-position:300% 0}}

/* ════ active tasks split into per-staff columns (req 1) ════ */
.ohub .actcols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.ohub .actcol{min-width:0}
.ohub .actcol-h{display:flex;align-items:center;gap:9px;padding:4px 4px 8px}
.ohub .actcol-h .nm{font-size:13.5px;font-weight:700;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ohub .actcol-h .count{font-size:12px;color:var(--muted)}

/* ════ proof thumbnail zoom + thread proof shot (req 2) ════ */
.ohub .thumb.zoomable{cursor:zoom-in}
.ohub .proof-shot{position:relative;margin:14px 0;border-radius:14px;overflow:hidden;border:1px solid var(--border);cursor:zoom-in;max-width:340px}
.ohub .proof-shot img{display:block;width:100%;max-height:300px;object-fit:cover}
.ohub .proof-zoom{position:absolute;right:8px;bottom:8px;font-size:11.5px;font-weight:600;color:#fff;background:rgba(0,0,0,.6);padding:4px 10px;border-radius:9999px}

/* ════ fullscreen image lightbox (req 2) — global, above everything ════ */
.ohub-lightbox{position:fixed;inset:0;z-index:95;background:rgba(0,0,0,.88);backdrop-filter:blur(4px);
  display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out;animation:oh-fade .15s ease}
.ohub-lightbox img{max-width:96vw;max-height:92vh;border-radius:14px;box-shadow:0 30px 90px rgba(0,0,0,.7);cursor:default}
.ohub-lightbox-close{position:fixed;top:18px;right:20px;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.25);
  background:rgba(0,0,0,.5);color:#fff;font-size:20px;cursor:pointer;display:grid;place-items:center}

/* ════ staff sticky performer + motivation hero (req 3 & 4) ════ */
.ohub .staff-hero{position:sticky;top:60px;z-index:30;display:flex;gap:14px;align-items:stretch;margin-bottom:18px}
.ohub .staff-hero .award-mini{flex:1 1 300px;margin-bottom:0}
.ohub .staff-hero .award-mini.hero .inner{align-items:center}
.ohub .staff-hero .award-mini.hero .photo{width:60px;height:60px}
.ohub .staff-hero .motiv{flex:1 1 250px;padding:16px}
.ohub .staff-hero .motiv-quote{font-size:15px}
@media(max-width:680px){.ohub .staff-hero{position:static;flex-direction:column}}

/* ════ staff lunch control (req 6) — 45-min allowance ════ */
.ohub .lunch-btn{font-family:inherit;font-size:13px;font-weight:700;padding:9px 16px;border-radius:9999px;cursor:pointer;
  border:1px solid rgba(245,158,11,.4);background:rgba(245,158,11,.12);color:#fcd34d;display:inline-flex;align-items:center;gap:6px}
.ohub .lunch-btn:hover{filter:brightness(1.08)}
.ohub .lunch-btn:disabled{opacity:.5;cursor:not-allowed}
.ohub .lunch-btn.end{background:var(--bg-2);border-color:var(--border);color:var(--ink)}
.ohub .lunch-live{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ohub .lunch-timer{font-size:13px;font-weight:700;color:#fcd34d;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.34);padding:7px 13px;border-radius:9999px}
.ohub .lunch-live.over .lunch-timer{color:#fca5a5;background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.4);animation:oh-lunch-pulse 1.4s ease-in-out infinite}
@keyframes oh-lunch-pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.4)}50%{box-shadow:0 0 0 6px rgba(239,68,68,0)}}

/* ════ check-in → office "active" linkage ════ */
/* owner team-status row: small green check-in time pill next to the name */
.ohub .chip-in{display:inline-flex;align-items:center;gap:3px;margin-left:6px;font-size:10.5px;font-weight:700;
  color:#86efac;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.32);padding:1px 7px;border-radius:9999px;vertical-align:middle}
/* staff page banner: shows whether the staff is checked in (active) today */
.ohub .checkin-banner{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:13px;font-weight:600;
  padding:11px 15px;border-radius:14px;margin-bottom:16px;border:1px solid var(--border);background:var(--bg-2);color:var(--ink)}
.ohub .checkin-banner .ci-dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex:none}
.ohub .checkin-banner .ci-tail{color:var(--muted);font-weight:500;font-size:12px}
.ohub .checkin-banner a{color:inherit;font-weight:700;text-decoration:underline}
.ohub .checkin-banner.in{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.34);color:#bbf7d0}
.ohub .checkin-banner.in .ci-dot{background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.5);animation:oh-ci-pulse 1.8s ease-in-out infinite}
.ohub .checkin-banner.in .ci-tail{color:#86efac}
.ohub .checkin-banner.off{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.34);color:#fcd34d}
.ohub .checkin-banner.off .ci-dot{background:#f59e0b}
.ohub .checkin-banner.out .ci-dot{background:#64748b}
@keyframes oh-ci-pulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}50%{box-shadow:0 0 0 5px rgba(34,197,94,0)}}
`
