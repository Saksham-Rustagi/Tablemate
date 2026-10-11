// Kin's live "thinking" dashboard: one self-contained HTML document.
// Served by the Bun server at /dash. It reads /dash/graph.json and the
// /dash/events SSE stream. With demo mode (renderDashboard({ demo: true }) or ?demo=1)
// it runs an in-page mock and never touches the network, so it also works from file://.
// No npm deps. The force layout is a small built-in simulation, so there are no CDN imports
// and the page still works on bad venue wifi.

export type DashOptions = { title?: string; demo?: boolean };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Deterministic background bubbles (CSS-only animation, transform-only = compositor cheap).
function bubbleSpans(): string {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const out: string[] = [];
  for (let i = 0; i < 16; i++) {
    const size = Math.round(14 + rnd() * 76);
    const left = (rnd() * 100).toFixed(1);
    const dur = (20 + rnd() * 22).toFixed(1);
    const delay = (-rnd() * 40).toFixed(1);
    const op = (0.45 + rnd() * 0.45).toFixed(2);
    out.push(
      '<span style="width:' + size + "px;height:" + size + "px;left:" + left +
        "%;animation-duration:" + dur + "s;animation-delay:" + delay + "s;opacity:" + op + '"></span>',
    );
  }
  return out.join("");
}

const CSS = String.raw`
:root{--ink:#0a3552;--ink2:#2f6487;--aqua:#16b3e8;--aqua2:#0a86c4;--r:28px}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
html{font-size:18px}
body{font-family:ui-rounded,"SF Pro Rounded",-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",Roboto,sans-serif;
  color:var(--ink);overflow:hidden;display:flex;flex-direction:column;background:#7fd3f7;-webkit-font-smoothing:antialiased}
.sky{position:fixed;inset:0;z-index:0;overflow:hidden;
  background:linear-gradient(180deg,#36aeee 0%,#79cdf8 20%,#c2ebfd 42%,#f0fbff 52%,#a9e7f3 55.5%,#5fc7df 68%,#2399c1 84%,#0a6893 100%)}
.sun{position:absolute;right:6%;top:-20vh;width:72vh;height:72vh;border-radius:50%;
  background:radial-gradient(circle,rgba(255,255,236,.95) 0%,rgba(255,250,215,.6) 16%,rgba(255,255,255,.2) 40%,rgba(255,255,255,0) 68%)}
.rays{position:absolute;right:-30vw;top:-80vh;width:160vh;height:160vh;opacity:.55;
  background:repeating-conic-gradient(from 10deg,rgba(255,255,255,.16) 0deg 5deg,rgba(255,255,255,0) 5deg 17deg);
  -webkit-mask-image:radial-gradient(circle,#000 0%,rgba(0,0,0,.4) 30%,transparent 60%);mask-image:radial-gradient(circle,#000 0%,rgba(0,0,0,.4) 30%,transparent 60%)}
.horizon{position:absolute;left:-10%;right:-10%;top:49%;height:9vh;
  background:radial-gradient(ellipse at center,rgba(255,255,255,.95),rgba(255,255,255,0) 70%)}
.water{position:absolute;left:0;right:0;top:56%;bottom:0;opacity:.8;
  background:repeating-linear-gradient(180deg,rgba(255,255,255,.13) 0 2px,rgba(255,255,255,0) 2px 26px);
  -webkit-mask-image:linear-gradient(180deg,#000,transparent 85%);mask-image:linear-gradient(180deg,#000,transparent 85%)}
.bubbles{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.bubbles span{position:absolute;bottom:-120px;border-radius:50%;will-change:transform;animation:rise linear infinite;
  background:radial-gradient(circle at 32% 28%,rgba(255,255,255,.95) 0 6%,rgba(255,255,255,.3) 14%,rgba(255,255,255,.05) 48%,rgba(190,240,255,.22) 68%,rgba(255,255,255,.6) 75%,rgba(255,255,255,0) 77%)}

.glass{position:relative;background:linear-gradient(180deg,rgba(255,255,255,.6),rgba(255,255,255,.28));
  -webkit-backdrop-filter:blur(18px) saturate(1.5);backdrop-filter:blur(18px) saturate(1.5);
  border:1px solid rgba(255,255,255,.82);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 0 0 1px rgba(255,255,255,.22),0 20px 44px rgba(4,58,104,.22)}
.glass::before{content:"";position:absolute;left:1px;right:1px;top:1px;height:46%;max-height:110px;border-radius:inherit;
  background:linear-gradient(180deg,rgba(255,255,255,.72),rgba(255,255,255,0));pointer-events:none;z-index:0}
.glass>*{position:relative;z-index:1}

.topbar{z-index:2;margin:18px 22px;padding:12px 22px;border-radius:26px;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:16px}
.logo{position:relative;width:56px;height:56px;border-radius:50%;flex:none;
  background:radial-gradient(circle at 35% 30%,#fff 0 9%,#b9f2ff 22%,#3cc3f1 55%,#0a74bd 100%);
  box-shadow:inset 0 -7px 12px rgba(255,255,255,.45),inset 0 2px 3px rgba(255,255,255,.9),0 7px 16px rgba(0,80,140,.35);
  display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:27px;text-shadow:0 1px 3px rgba(0,60,120,.5)}
.logo::before{content:"";position:absolute;left:-3px;bottom:-1px;width:17px;height:17px;border-radius:50%;
  background:radial-gradient(circle at 40% 35%,#c7f4ff,#1f9ad8);box-shadow:0 3px 6px rgba(0,80,140,.3)}
.logo::after{content:"";position:absolute;left:17%;top:5%;width:66%;height:42%;border-radius:50%;
  background:linear-gradient(180deg,rgba(255,255,255,.95),rgba(255,255,255,.08))}
h1{margin:0;font-size:32px;font-weight:800;letter-spacing:-.01em;color:#08385d;text-shadow:0 1px 0 rgba(255,255,255,.9)}
.sub{font-size:16px;color:var(--ink2);font-weight:600}
.pills{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:.45em;padding:.4em 1em;border-radius:999px;font-size:18px;font-weight:700;white-space:nowrap;color:#4a6378;
  border:1px solid rgba(255,255,255,.95);
  background:linear-gradient(180deg,rgba(255,255,255,.96) 0%,rgba(236,244,250,.92) 49%,rgba(213,227,238,.92) 50%,rgba(236,244,250,.96) 100%);
  box-shadow:inset 0 1px 0 #fff,0 3px 8px rgba(0,60,110,.18);transition:color .4s}
.pill .v{font-weight:900}
.pill.ok{color:#0b4d1d;background:linear-gradient(180deg,#ecffec 0%,#b8f3bb 49%,#7cdb88 50%,#a7edae 100%)}
.pill.bad{color:#7a1d12;background:linear-gradient(180deg,#fff1ed 0%,#ffcbc0 49%,#ffa393 50%,#ffc3b7 100%)}
.pill.warn{color:#6b4300;background:linear-gradient(180deg,#fff8e6 0%,#ffe4a6 49%,#ffcf6c 50%,#ffe09a 100%)}
.pill.demo{color:#3f2a86;background:linear-gradient(180deg,#f8f3ff 0%,#e2d5ff 49%,#c8b2ff 50%,#ddd0ff 100%)}
.pill .dot{width:10px;height:10px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px rgba(255,255,255,.65)}
.pill.ok .dot,.pill.demo .dot{animation:blink 1.6s ease-in-out infinite}
.dbtn{font:inherit;font-size:16px;font-weight:800;padding:.4em 1em;border-radius:999px;cursor:pointer;white-space:nowrap;color:#08385d;
  border:1px solid rgba(255,255,255,.95);
  background:linear-gradient(180deg,#f2fbff 0%,#c9ecff 49%,#8fd3f7 50%,#bfe8fd 100%);
  box-shadow:inset 0 1px 0 #fff,0 3px 8px rgba(0,60,110,.2)}
.dbtn:active{transform:translateY(1px);box-shadow:inset 0 1px 0 #fff,0 1px 3px rgba(0,60,110,.2)}
.dbtn:disabled{opacity:.55;cursor:default}
.dbtn.reset{color:#7a1d12;background:linear-gradient(180deg,#fff6f3 0%,#ffd9cf 49%,#ffb4a5 50%,#ffd2c8 100%)}
.clock{font-size:21px;font-weight:800;color:var(--ink2);font-variant-numeric:tabular-nums;margin-left:4px;min-width:5.2em;text-align:right}

main{position:relative;z-index:1;flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,4fr) minmax(0,6fr);gap:22px;padding:0 22px 22px}
.panel{display:flex;flex-direction:column;min-height:0;border-radius:var(--r);overflow:hidden}
.phead{display:flex;align-items:center;gap:14px;padding:16px 22px 10px}
.phead h2{margin:0;font-size:25px;font-weight:800;color:#08385d;white-space:nowrap}
.stats{margin-left:auto;font-size:17px;color:var(--ink2);font-weight:700;text-align:right;min-width:0}
.dots{display:inline-flex;align-items:center}
.listening{flex:none;white-space:nowrap;font-size:16px;color:var(--aqua2);font-weight:800;display:inline-flex;align-items:center;gap:5px;padding:3px 11px;border-radius:999px;
  background:rgba(255,255,255,.65);border:1px solid rgba(255,255,255,.9)}
.dots i{display:inline-block;width:5px;height:5px;margin:0 1px;border-radius:50%;background:currentColor;animation:dot 1.2s infinite ease-in-out}
.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}

.feed{flex:1;min-height:0;overflow-y:auto;padding:6px 18px 18px;scrollbar-width:thin;scrollbar-color:rgba(10,134,196,.35) transparent}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"meta badge" "msg badge" "chips badge";gap:6px 16px;align-items:start;
  padding:14px 16px 14px 24px;margin-bottom:12px;border-radius:20px;position:relative;overflow:hidden;
  background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(236,248,255,.8));border:1px solid #fff;
  box-shadow:inset 0 1px 0 #fff,inset 0 -8px 16px rgba(160,220,250,.18),0 8px 18px rgba(8,70,120,.14);
  animation:rowIn .6s cubic-bezier(.2,.9,.25,1.15) both}
.row::after{content:"";position:absolute;left:0;top:0;bottom:0;width:8px;background:linear-gradient(180deg,var(--c),var(--c2))}
.row.act-protect,.row.act-alert{background:linear-gradient(180deg,#fff,#fff0ec);box-shadow:inset 0 1px 0 #fff,0 0 0 3px rgba(255,128,108,.45),0 8px 18px rgba(160,60,40,.16)}
.meta{grid-area:meta;display:flex;gap:14px;font-size:16px;color:var(--ink2);font-weight:700;font-variant-numeric:tabular-nums}
.ms{color:#5b7a91}
.msg{grid-area:msg;font-size:20px;line-height:1.32;overflow-wrap:anywhere}
.from{font-weight:800;color:#08385d}
.arrow{color:var(--aqua2);font-weight:900}
.preview{color:#21506f}
.chips{grid-area:chips;display:flex;flex-wrap:wrap;gap:7px;margin-top:3px}
.chip{font-size:16px;padding:3px 12px 4px;border-radius:999px;border:1px solid rgba(255,255,255,.9);color:#fff;font-weight:600;
  background:linear-gradient(180deg,rgba(255,255,255,.45) 0%,rgba(255,255,255,.1) 50%,rgba(255,255,255,0) 51%),linear-gradient(180deg,var(--k1),var(--k2));
  box-shadow:0 2px 5px rgba(0,50,90,.16);text-shadow:0 1px 1px rgba(0,0,0,.22)}
.chip b{font-weight:900;margin-right:1px}
.c-r{--k1:#5cc4ff;--k2:#1f7fd1}.c-p{--k1:#ffa08c;--k2:#e65e4c}.c-q{--k1:#a9bed3;--k2:#6782a0}
.c-m{--k1:#c5aaff;--k2:#8058de}.c-t{--k1:#8fe28c;--k2:#36a548}.c-x{--k1:#7fe0e6;--k2:#159fae}
.badge{grid-area:badge;align-self:center;min-width:140px;padding:11px 14px;border-radius:18px;text-align:center;color:#fff;
  display:flex;flex-direction:column;align-items:center;gap:3px;
  background:linear-gradient(180deg,rgba(255,255,255,.55) 0%,rgba(255,255,255,.12) 50%,rgba(255,255,255,0) 51%),linear-gradient(180deg,var(--c),var(--c2));
  border:1px solid rgba(255,255,255,.85);box-shadow:inset 0 -4px 10px rgba(255,255,255,.25),0 6px 14px rgba(0,50,90,.22);text-shadow:0 1px 2px rgba(0,0,0,.28)}
.bi{font-size:27px;line-height:1}
.bt{font-size:19px;font-weight:900;letter-spacing:.08em}
.act-card{--c:#4cc2fa;--c2:#1573c6}.act-protect{--c:#ff9c86;--c2:#e8594a}.act-quiet{--c:#adc0d3;--c2:#6a85a2}
.act-hold{--c:#ffd27a;--c2:#df9420}.act-reply{--c:#5fe0cf;--c2:#11a191}.act-memory{--c:#c4a8ff;--c2:#7c54dc}
.act-reminder{--c:#90e58b;--c2:#31a446}.act-alert{--c:#ff8ea6;--c2:#d4315a}
.logline{display:flex;gap:12px;align-items:baseline;font-size:16px;padding:7px 14px;margin-bottom:10px;border-radius:14px;
  background:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.65);color:#2f5a78;animation:rowIn .5s ease both;overflow-wrap:anywhere}
.logline .time{font-variant-numeric:tabular-nums;color:#5b7a91;font-weight:700;flex:none}
.logline.warn{color:#9c5a00;background:rgba(255,246,220,.78)}
.logline.error{color:#c1242c;background:rgba(255,232,229,.82);font-weight:700}
.logline.mem{color:#5a3cc2;background:rgba(243,236,255,.78);font-weight:700}
.empty{display:flex;flex-direction:column;align-items:center;gap:16px;padding:64px 20px;color:var(--ink2);font-size:20px;font-weight:700}
.orb{width:72px;height:72px;border-radius:50%;animation:bob 3s ease-in-out infinite alternate;
  background:radial-gradient(circle at 35% 30%,#fff 0 9%,#b9f2ff 24%,#3cc3f1 58%,#0a74bd 100%);box-shadow:inset 0 -8px 14px rgba(255,255,255,.4),0 10px 20px rgba(0,80,140,.3)}

.mapwrap{flex:1;min-height:0;position:relative;
  background:radial-gradient(circle at 50% 52%,rgba(255,255,255,.55),rgba(255,255,255,0) 46%)}
#map{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;overflow:visible}
#map text{font-family:inherit}
.mapempty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:var(--ink2);pointer-events:none}
.legend{position:absolute;left:18px;bottom:14px;right:18px;display:flex;flex-wrap:wrap;gap:8px;pointer-events:none}
.legend span{display:inline-flex;align-items:center;gap:7px;font-size:15px;font-weight:700;color:#1f4f70;padding:3px 11px 3px 6px;border-radius:999px;
  background:rgba(255,255,255,.62);border:1px solid rgba(255,255,255,.9)}
.legend i{width:15px;height:15px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff 0 12%,var(--a) 42%,var(--b) 100%);box-shadow:0 1px 3px rgba(0,0,0,.2)}

.node{cursor:grab}
.node:active{cursor:grabbing}
.node .float{animation:bob 6s ease-in-out infinite alternate}
.node .pop.pre{transform:scale(0)}
.node .pop.popping{animation:pop .8s cubic-bezier(.2,.9,.3,1.25) both}
.node .ring{fill:none;stroke:#fff;stroke-width:3;opacity:0}
.node .pop.popping .ring{animation:ring 1.1s ease-out .12s}
.node .halo{opacity:0}
.node.hl .halo{animation:halo .9s ease-in-out infinite alternate}
.node .rim{fill:none;stroke:rgba(255,255,255,.85);stroke-width:1.5}
.node .label{font-size:18px;font-weight:800;fill:#0a3552;text-anchor:middle;paint-order:stroke;stroke:rgba(255,255,255,.95);stroke-width:5px;stroke-linejoin:round}
.node.hl .label{fill:#0274b4}
.node .emoji{text-anchor:middle;dominant-baseline:central}
.spark{fill:#fff;font-size:17px;text-anchor:middle;dominant-baseline:central;paint-order:stroke;stroke:rgba(255,200,90,.9);stroke-width:2px;animation:spark 1s ease-out forwards}
.newtag{font-size:16px;font-weight:900;fill:#0a86c4;text-anchor:middle;paint-order:stroke;stroke:#fff;stroke-width:5px;stroke-linejoin:round;animation:newtag 3.2s ease-out forwards}
.lg .under{fill:none;stroke:rgba(70,180,235,.32);stroke-width:7;stroke-linecap:round}
.lg .over{fill:none;stroke:rgba(255,255,255,.96);stroke-width:2.4;stroke-linecap:round}
.lg.hl .under{stroke:rgba(100,236,255,.9);animation:lpulse .9s ease-in-out infinite alternate}
.lg.hl .over{stroke:#fff;stroke-width:3.6}
.lg.fresh .over{stroke-dasharray:1 1;stroke-dashoffset:1;animation:draw 1s ease-out forwards}
.lg.fresh .under{animation:fresh 2.6s ease-out}
.lrel{font-size:15px;font-weight:800;fill:#1b5a82;text-anchor:middle;paint-order:stroke;stroke:rgba(255,255,255,.93);stroke-width:4px;stroke-linejoin:round;pointer-events:none}
.lrel.hl{fill:#0274b4}
.lrel.fresh{animation:fadeIn 1.2s ease-out}

@keyframes rise{0%{transform:translate3d(0,0,0)}25%{transform:translate3d(18px,-32vh,0)}50%{transform:translate3d(-14px,-64vh,0)}75%{transform:translate3d(12px,-96vh,0)}100%{transform:translate3d(0,-130vh,0)}}
@keyframes rowIn{from{opacity:0;transform:translateY(-18px) scale(.97)}to{opacity:1;transform:none}}
@keyframes bob{from{transform:translateY(-3px)}to{transform:translateY(3px)}}
@keyframes pop{0%{transform:scale(0)}55%{transform:scale(1.15)}78%{transform:scale(.96)}100%{transform:scale(1)}}
@keyframes ring{0%{opacity:.95;transform:scale(1)}100%{opacity:0;transform:scale(2.3)}}
@keyframes halo{from{opacity:.45;transform:scale(.94)}to{opacity:1;transform:scale(1.12)}}
@keyframes spark{0%{opacity:1;transform:translate(0,0) scale(.4)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(1.15)}}
@keyframes newtag{0%{opacity:0;transform:translateY(8px)}12%{opacity:1;transform:translateY(0)}75%{opacity:1}100%{opacity:0;transform:translateY(-10px)}}
@keyframes lpulse{from{stroke-width:7}to{stroke-width:15}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes fresh{0%{stroke:rgba(100,236,255,1);stroke-width:16}100%{stroke:rgba(70,180,235,.32);stroke-width:7}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes blink{50%{opacity:.35}}
@keyframes dot{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-4px);opacity:1}}
@media (max-width:1100px){main{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) minmax(0,1.3fr)}}
`;

// Browser-side code. NOTE: no backticks or dollar-brace sequences in here (it lives in a String.raw template).
const CLIENT_JS = String.raw`
const DEMO = window.__KIN_DEMO__ === true || new URLSearchParams(location.search).get("demo") === "1";
const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

// ---------- helpers ----------
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return "";
  return fmt.formatToParts(d).filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function sv(tag, attrs, parent) { const e = document.createElementNS(NS, tag); if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function truncate(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "\u2026" : s; }
function restart(elm, cls) { elm.classList.remove(cls); void elm.getBoundingClientRect(); elm.classList.add(cls); }

// ---------- clock ----------
function tickClock() { $("clock").textContent = fmtTime(); }
tickClock(); setInterval(tickClock, 1000);

// ---------- health ----------
function setPill(id, state, value) { const p = $(id); if (!p) return; p.className = "pill " + state; p.querySelector(".v").textContent = value; }
function setHealth(h) {
  setPill("h-local", h.local ? "ok" : "bad", h.local ? "\u2713" : "\u2717");
  setPill("h-cloud", h.cloud ? "ok" : "bad", h.cloud ? "\u2713" : "\u2717");
  setPill("h-tunnel", h.tunnel ? "ok" : "bad", h.tunnel ? "\u2713" : "\u2717");
  const g = h.gemini || { used: 0, limit: 0 };
  const ratio = g.limit ? g.used / g.limit : 0;
  setPill("h-gemini", ratio >= 1 ? "bad" : ratio >= 0.8 ? "warn" : "ok", (g.used ?? 0) + "/" + (g.limit ?? 0));
}
function setConn(state) {
  if (state === "live") setPill("conn", "ok", "Live");
  else if (state === "demo") setPill("conn", "demo", "Demo");
  else if (state === "retry") setPill("conn", "warn", "Reconnecting\u2026");
  else setPill("conn", "", "Connecting\u2026");
}

// ---------- decision feed ----------
const feed = $("feed");
const MAX_ROWS = 60;
const ACTIONS = {
  card: ["CARD", "\u{1F48C}"], protect: ["PROTECT", "\u{1F6E1}\uFE0F"], quiet: ["QUIET", "\u{1F92B}"], hold: ["HOLD", "\u23F8\uFE0F"],
  reply: ["REPLY", "\u{1F4AC}"], memory: ["MEMORY", "\u{1F9E0}"], reminder: ["REMINDER", "\u23F0"], alert: ["ALERT", "\u{1F6A8}"],
};
let nDecisions = 0, nProtect = 0;
function chipClass(r) { const c = String(r || "").trim().charAt(0).toUpperCase(); return ({ R: "c-r", P: "c-p", Q: "c-q", M: "c-m", T: "c-t" })[c] || "c-x"; }
function pushRow(row) {
  const empty = $("empty"); if (empty) empty.remove();
  feed.insertBefore(row, feed.firstChild);
  while (feed.children.length > MAX_ROWS) feed.removeChild(feed.lastChild);
  if (feed.scrollTop < 200) feed.scrollTop = 0;
}
function updateStats() { $("stats").textContent = nDecisions + " decisions \u00B7 " + nProtect + " protected"; }
function addDecision(e) {
  const known = Object.prototype.hasOwnProperty.call(ACTIONS, e.action);
  const a = known ? ACTIONS[e.action] : [String(e.action || "?").toUpperCase(), "\u2022"];
  const row = el("div", "row decision act-" + (known ? e.action : "quiet"));
  const meta = el("div", "meta");
  meta.appendChild(el("span", "time", fmtTime(e.at)));
  if (typeof e.ms === "number" && isFinite(e.ms)) meta.appendChild(el("span", "ms", "\u23F1 " + (e.ms / 1000).toFixed(1) + "s"));
  const msg = el("div", "msg");
  msg.appendChild(el("span", "from", e.from || "Someone"));
  msg.appendChild(el("span", "arrow", " \u2192 "));
  msg.appendChild(el("span", "preview", "\u201C" + truncate(e.preview, 80) + "\u201D"));
  const chips = el("div", "chips");
  (Array.isArray(e.rules) ? e.rules : []).forEach((r) => {
    const s = String(r); const i = s.indexOf(" ");
    const c = el("span", "chip " + chipClass(s));
    c.appendChild(el("b", null, i > 0 ? s.slice(0, i) : s));
    if (i > 0) c.appendChild(document.createTextNode(" " + s.slice(i + 1)));
    chips.appendChild(c);
  });
  const badge = el("div", "badge");
  badge.appendChild(el("span", "bi", a[1]));
  badge.appendChild(el("span", "bt", a[0]));
  row.append(meta, badge, msg, chips);
  pushRow(row);
  nDecisions++; if (e.action === "protect" || e.action === "alert") nProtect++;
  updateStats();
}
function addLog(e, extraCls) {
  const lvl = e.level === "warn" || e.level === "error" ? e.level : "info";
  const row = el("div", "logline " + (extraCls || lvl));
  row.appendChild(el("span", "time", fmtTime(e.at)));
  row.appendChild(el("span", "txt", (lvl === "warn" ? "\u26A0\uFE0F " : lvl === "error" ? "\u26D4 " : "") + String(e.text || "")));
  pushRow(row);
}

// ---------- memory map ----------
const KINDS = {
  asha:   { emoji: "\u{1F475}", a: "#fff7d6", b: "#ffcf7a", c: "#f08f3c", name: "Asha" },
  person: { emoji: "\u{1F9D1}", a: "#e6fbff", b: "#7fd8ff", c: "#1b8fd6", name: "Family" },
  pet:    { emoji: "\u{1F436}", a: "#f0ffe0", b: "#a6ec7c", c: "#3ea73a", name: "Pets" },
  place:  { emoji: "\u{1F4CD}", a: "#e3fffa", b: "#6fe9d6", c: "#119c94", name: "Places" },
  event:  { emoji: "\u{1F389}", a: "#f6f0ff", b: "#cdb6ff", c: "#8462dc", name: "Events" },
  thing:  { emoji: "\u2728",    a: "#ffffff", b: "#dfe7ef", c: "#8e9cad", name: "Things" },
};
const svg = $("map");
const wrap = $("mapwrap");
const defs = sv("defs", null, svg);
for (const k in KINDS) {
  const g = sv("radialGradient", { id: "g-" + k, cx: "40%", cy: "34%", r: "72%", fx: "34%", fy: "26%" }, defs);
  sv("stop", { offset: "0%", "stop-color": KINDS[k].a }, g);
  sv("stop", { offset: "55%", "stop-color": KINDS[k].b }, g);
  sv("stop", { offset: "100%", "stop-color": KINDS[k].c }, g);
}
(function () {
  const gl = sv("linearGradient", { id: "gloss", x1: "0", y1: "0", x2: "0", y2: "1" }, defs);
  sv("stop", { offset: "0%", "stop-color": "#fff", "stop-opacity": "0.95" }, gl);
  sv("stop", { offset: "100%", "stop-color": "#fff", "stop-opacity": "0.04" }, gl);
  const gb = sv("radialGradient", { id: "glowb", cx: "50%", cy: "100%", r: "80%" }, defs);
  sv("stop", { offset: "0%", "stop-color": "#fff", "stop-opacity": "0.6" }, gb);
  sv("stop", { offset: "100%", "stop-color": "#fff", "stop-opacity": "0" }, gb);
  const h = sv("radialGradient", { id: "halo" }, defs);
  sv("stop", { offset: "52%", "stop-color": "#8ff3ff", "stop-opacity": "0" }, h);
  sv("stop", { offset: "74%", "stop-color": "#8ff3ff", "stop-opacity": "0.95" }, h);
  sv("stop", { offset: "100%", "stop-color": "#bff8ff", "stop-opacity": "0" }, h);
  const f = sv("filter", { id: "shadow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
  sv("feDropShadow", { dx: "0", dy: "6", stdDeviation: "6", "flood-color": "#0a4a7a", "flood-opacity": "0.3" }, f);
})();
const gLinks = sv("g", { class: "links" }, svg);
const gRel = sv("g", { class: "rels" }, svg);
const gNodes = sv("g", { class: "nodes" }, svg);

// legend
(function () {
  const lg = $("legend");
  for (const k in KINDS) {
    const s = el("span"); const i = el("i");
    i.style.setProperty("--a", KINDS[k].b); i.style.setProperty("--b", KINDS[k].c);
    s.appendChild(i); s.appendChild(document.createTextNode(KINDS[k].name)); lg.appendChild(s);
  }
})();

const nodes = []; const byId = new Map(); const links = []; const linkKeys = new Set(); let pending = [];
let W = 900, H = 640, clipSeq = 0;
function idOf(x) { return x && typeof x === "object" ? x.id : String(x); }
function radius(n) { if (n.kind === "asha") return 44; const m = Math.max(0, Number(n.memories) || 0); return Math.min(38, 22 + Math.sqrt(m) * 4); }
function updateCounts() {
  $("mapstats").textContent = nodes.length + " remembered \u00B7 " + links.length + " connections";
  $("mapempty").style.display = nodes.length ? "none" : "flex";
}

function drawNode(n) {
  const p = n.pop;
  while (p.firstChild) p.removeChild(p.firstChild);
  const r = n.r, K = KINDS[n.kind];
  sv("circle", { class: "halo", r: r + 20, fill: "url(#halo)" }, p);
  sv("circle", { class: "ring", r: r }, p);
  sv("circle", { class: "body", r: r, fill: "url(#g-" + n.kind + ")", filter: "url(#shadow)" }, p);
  const addEmoji = () => { const t = sv("text", { class: "emoji", y: 1, "font-size": Math.round(r * 1.02) }, p); t.textContent = K.emoji; return t; };
  if (n.photo) {
    const cid = "clip" + (++clipSeq);
    const cp = sv("clipPath", { id: cid }, defs); sv("circle", { r: r - 2.5 }, cp);
    const img = sv("image", { x: -r, y: -r, width: r * 2, height: r * 2, preserveAspectRatio: "xMidYMid slice", "clip-path": "url(#" + cid + ")" }, p);
    img.setAttribute("href", n.photo);
    img.addEventListener("error", () => { const em = addEmoji(); img.replaceWith(em); });
  } else addEmoji();
  sv("ellipse", { class: "glowb", cx: 0, cy: r * 0.5, rx: r * 0.6, ry: r * 0.32, fill: "url(#glowb)" }, p);
  sv("ellipse", { class: "gloss", cx: 0, cy: -r * 0.46, rx: r * 0.64, ry: r * 0.38, fill: "url(#gloss)" }, p);
  sv("circle", { class: "rim", r: r - 0.75 }, p);
  const lab = sv("text", { class: "label", y: r + 22 }, p); lab.textContent = truncate(n.label, 20);
  const tip = sv("title", null, p); tip.textContent = n.label + (n.relation ? " (" + n.relation + ")" : "") + (n.memories ? " \u00B7 " + n.memories + " memories" : "");
}

function addNode(raw, opt) {
  if (!raw || raw.id == null) return null;
  opt = opt || {};
  const id = String(raw.id);
  let n = byId.get(id);
  if (n) {
    const before = n.label + "|" + n.photo + "|" + n.r + "|" + n.kind;
    if (raw.label) n.label = raw.label;
    if (raw.photo !== undefined) n.photo = raw.photo || null;
    if (raw.relation !== undefined) n.relation = raw.relation || null;
    if (raw.memories !== undefined) n.memories = raw.memories || 0;
    if (raw.kind && KINDS[raw.kind]) n.kind = raw.kind;
    n.r = radius(n);
    if (before !== n.label + "|" + n.photo + "|" + n.r + "|" + n.kind) { drawNode(n); reheat(0.2); }
    return n;
  }
  n = { id: id, label: raw.label || id, kind: KINDS[raw.kind] ? raw.kind : "thing", photo: raw.photo || null, relation: raw.relation || null,
        memories: raw.memories || 0, vx: 0, vy: 0, fx: null, fy: null, deg: 0 };
  n.r = radius(n);
  const asha = nodes.find((m) => m.kind === "asha");
  if (n.kind === "asha") { n.x = W / 2; n.y = H / 2; }
  else {
    const base = asha || { x: W / 2, y: H / 2 };
    const ang = opt.angle != null ? opt.angle : Math.random() * Math.PI * 2;
    const dist = opt.dist || 150 + Math.random() * 60;
    n.x = base.x + Math.cos(ang) * dist; n.y = base.y + Math.sin(ang) * dist;
  }
  n.el = sv("g", { class: "node k-" + n.kind, "data-id": id }, gNodes);
  const fl = sv("g", { class: "float" }, n.el);
  fl.style.animationDelay = (-Math.random() * 6).toFixed(2) + "s";
  fl.style.animationDuration = (5 + Math.random() * 2.5).toFixed(2) + "s";
  n.pop = sv("g", { class: "pop" }, fl);
  drawNode(n);
  nodes.push(n); byId.set(id, n);
  if (opt.pop) pop(n, opt.delay || 0, !!opt.live);
  flushPending();
  updateCounts();
  reheat(opt.live ? 0.8 : 0.6);
  return n;
}

function pop(n, delay, live) {
  const p = n.pop;
  p.classList.add("pre");
  setTimeout(() => {
    p.classList.remove("pre");
    restart(p, "popping");
    if (live) { sparkle(n); newTag(n); }
    setTimeout(() => p.classList.remove("popping"), 1400);
  }, delay);
}
function sparkle(n) {
  const glyphs = ["\u2726", "\u2727", "\u2022", "\u2726"];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
    const s = sv("text", { class: "spark", x: (Math.cos(a) * n.r).toFixed(1), y: (Math.sin(a) * n.r).toFixed(1) }, n.pop);
    s.textContent = glyphs[i % glyphs.length];
    s.style.setProperty("--dx", (Math.cos(a) * 34).toFixed(1) + "px");
    s.style.setProperty("--dy", (Math.sin(a) * 34).toFixed(1) + "px");
    s.style.animationDelay = (0.15 + Math.random() * 0.15).toFixed(2) + "s";
    setTimeout(() => s.remove(), 1500);
  }
}
function newTag(n) {
  const t = sv("text", { class: "newtag", y: -n.r - 16 }, n.pop);
  t.textContent = "\u2728 new memory";
  setTimeout(() => t.remove(), 3300);
}

function addLink(raw, opt) {
  if (!raw) return;
  opt = opt || {};
  const s = idOf(raw.source), t = idOf(raw.target), rel = raw.rel || "";
  const key = s + "\u0000" + t + "\u0000" + rel;
  if (linkKeys.has(key)) return;
  const sn = byId.get(s), tn = byId.get(t);
  if (!sn || !tn) { if (pending.length < 500) pending.push({ raw: raw, opt: opt }); return; }
  linkKeys.add(key);
  const l = { s: sn, t: tn, rel: rel };
  l.g = sv("g", { class: "lg" }, gLinks);
  l.under = sv("path", { class: "under" }, l.g);
  l.over = sv("path", { class: "over", pathLength: "1" }, l.g);
  l.text = sv("text", { class: "lrel" }, gRel); l.text.textContent = rel;
  sn.deg++; tn.deg++;
  links.push(l);
  if (opt.fresh) {
    l.g.classList.add("fresh"); l.text.classList.add("fresh");
    setTimeout(() => { l.g.classList.remove("fresh"); l.text.classList.remove("fresh"); }, 2700);
  }
  updateCounts();
  reheat(opt.fresh ? 0.6 : 0.4);
}
function flushPending() { const p = pending; pending = []; p.forEach((x) => addLink(x.raw, x.opt)); }

const hlTimers = new WeakMap();
function highlight(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const set = new Set(ids.map(String).filter((id) => byId.has(id)));
  if (!set.size) return;
  const marks = [];
  set.forEach((id) => marks.push(byId.get(id).el));
  links.forEach((l) => {
    const a = set.has(l.s.id), b = set.has(l.t.id);
    if ((a && b) || (set.size === 1 && (a || b))) { marks.push(l.g); marks.push(l.text); }
  });
  marks.forEach((m) => {
    restart(m, "hl");
    clearTimeout(hlTimers.get(m));
    hlTimers.set(m, setTimeout(() => m.classList.remove("hl"), 4000));
  });
}

// ---- tiny force simulation (d3-force style: links + many-body + collide + centering) ----
let alpha = 1, alphaTarget = 0, running = false;
function reheat(a) { alpha = Math.max(alpha, a); if (!running) { running = true; requestAnimationFrame(step); } }
function step() {
  tick(); tick();
  render();
  if (alpha > 0.004 || alphaTarget > 0) requestAnimationFrame(step); else running = false;
}
function tick() {
  alpha += (alphaTarget - alpha) * 0.02;
  const cx = W / 2, cy = H / 2 - 6;
  for (const l of links) {
    const s = l.s, t = l.t;
    let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const want = s.r + t.r + (s.kind === "asha" || t.kind === "asha" ? 115 : 72);
    const f = ((d - want) / d) * alpha * (0.9 / Math.min(s.deg, t.deg));
    dx *= f; dy *= f;
    const bias = s.deg / (s.deg + t.deg);
    t.vx -= dx * bias; t.vy -= dy * bias; s.vx += dx * (1 - bias); s.vy += dy * (1 - bias);
  }
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
      const w = (-(a.r + b.r) * 15 * alpha) / d2;
      a.vx += dx * w; a.vy += dy * w; b.vx -= dx * w; b.vy -= dy * w;
      const rr = a.r + b.r + 26;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2);
        const push = ((rr - d) / d) * 0.35;
        const ra = a.r * a.r, rb = b.r * b.r, tot = ra + rb;
        a.vx -= dx * push * (rb / tot); a.vy -= dy * push * (rb / tot);
        b.vx += dx * push * (ra / tot); b.vy += dy * push * (ra / tot);
      }
    }
  }
  for (const n of nodes) {
    const k = n.kind === "asha" ? 0.22 : 0.035;
    n.vx += (cx - n.x) * k * alpha; n.vy += (cy - n.y) * k * alpha;
    if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; }
    else { n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx; n.y += n.vy; }
    n.x = Math.max(n.r + 10, Math.min(W - n.r - 10, n.x));
    n.y = Math.max(n.r + 34, Math.min(H - n.r - 70, n.y));
  }
}
function render() {
  for (const n of nodes) n.el.setAttribute("transform", "translate(" + n.x.toFixed(1) + "," + n.y.toFixed(1) + ")");
  for (const l of links) {
    const sx = l.s.x, sy = l.s.y, tx = l.t.x, ty = l.t.y;
    const qx = (sx + tx) / 2 - (ty - sy) * 0.12, qy = (sy + ty) / 2 + (tx - sx) * 0.12;
    const d = "M" + sx.toFixed(1) + "," + sy.toFixed(1) + " Q" + qx.toFixed(1) + "," + qy.toFixed(1) + " " + tx.toFixed(1) + "," + ty.toFixed(1);
    l.under.setAttribute("d", d); l.over.setAttribute("d", d);
    l.text.setAttribute("x", (0.25 * sx + 0.5 * qx + 0.25 * tx).toFixed(1));
    l.text.setAttribute("y", (0.25 * sy + 0.5 * qy + 0.25 * ty - 5).toFixed(1));
  }
}
function resize() {
  const r = wrap.getBoundingClientRect();
  W = Math.max(320, r.width); H = Math.max(260, r.height);
  svg.setAttribute("viewBox", "0 0 " + W.toFixed(0) + " " + H.toFixed(0));
  reheat(0.3);
}
new ResizeObserver(resize).observe(wrap);
resize();

// dragging
let drag = null;
svg.addEventListener("pointerdown", (ev) => {
  const g = ev.target.closest && ev.target.closest(".node"); if (!g) return;
  const n = byId.get(g.getAttribute("data-id")); if (!n) return;
  drag = n; svg.setPointerCapture(ev.pointerId);
  n.fx = n.x; n.fy = n.y; alphaTarget = 0.25; reheat(0.3);
});
svg.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const r = svg.getBoundingClientRect();
  drag.fx = (ev.clientX - r.left) * (W / r.width); drag.fy = (ev.clientY - r.top) * (H / r.height);
});
function endDrag() { if (drag) { drag.fx = null; drag.fy = null; drag = null; alphaTarget = 0; } }
svg.addEventListener("pointerup", endDrag);
svg.addEventListener("pointercancel", endDrag);

function applyGraph(g, animate) {
  const ns = (g && Array.isArray(g.nodes)) ? g.nodes.slice() : [];
  ns.sort((a, b) => (a.kind === "asha" ? -1 : 0) - (b.kind === "asha" ? -1 : 0));
  const fresh = ns.filter((n) => !byId.has(String(n.id)));
  const others = Math.max(1, fresh.filter((n) => n.kind !== "asha").length);
  let k = 0;
  ns.forEach((n, i) => {
    const isNew = !byId.has(String(n.id));
    const ang = n.kind === "asha" ? 0 : (k++ / others) * Math.PI * 2 - Math.PI / 2;
    addNode(n, { pop: animate && isNew, delay: i * 110, angle: ang, dist: 170 });
  });
  ((g && Array.isArray(g.links)) ? g.links : []).forEach((l) => addLink(l, { fresh: false }));
}

// ---------- event router ----------
function handle(ev) {
  if (!ev || typeof ev !== "object") return;
  if (ev.kind === "log") addLog(ev);
  else if (ev.kind === "decision") { addDecision(ev); if (Array.isArray(ev.highlight) && ev.highlight.length) highlight(ev.highlight); }
  else if (ev.kind === "graph") {
    if (ev.op === "add_node" && ev.node) {
      const isNew = !byId.has(String(ev.node.id));
      addNode(ev.node, { pop: true, live: true });
      if (isNew) addLog({ at: new Date().toISOString(), level: "info", text: "\u2728 Memory map: + " + (ev.node.label || ev.node.id) + " (" + (ev.node.kind || "thing") + ")" }, "mem");
    }
    else if (ev.op === "add_link" && ev.link) addLink(ev.link, { fresh: true });
    else if (ev.op === "highlight") highlight(ev.ids);
  }
  else if (ev.kind === "health") setHealth(ev);
}
window.kinDash = { handle: handle, highlight: highlight };

// ---------- live mode ----------
let graphLoadedOnce = false;
function loadGraph() {
  return fetch("/dash/graph.json", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((g) => { applyGraph(g, !graphLoadedOnce); graphLoadedOnce = true; })
    .catch((err) => addLog({ at: new Date().toISOString(), level: "warn", text: "Couldn't load memory map: " + err.message }));
}
function clearGraph() {
  [gNodes, gLinks, gRel].forEach((g) => { while (g.firstChild) g.removeChild(g.firstChild); });
  nodes.length = 0; byId.clear(); links.length = 0; linkKeys.clear(); pending = [];
  updateCounts();
}
function clearFeed() {
  while (feed.firstChild) feed.removeChild(feed.firstChild);
  const empty = el("div", "empty"); empty.id = "empty"; empty.appendChild(el("div", "orb")); empty.appendChild(document.createTextNode("Waiting for family messages…"));
  feed.appendChild(empty);
  nDecisions = 0; nProtect = 0; updateStats();
}
function post(url) {
  return fetch(url, { method: "POST" }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
}
function wireButtons() {
  const reset = $("b-reset"), rem = $("b-reminder"), today = $("b-today");
  reset.onclick = () => {
    if (!confirm("Reset the demo? This re-seeds the family and clears cards, reminders and memories.")) return;
    reset.disabled = true;
    post("/dash/reset")
      .then(() => { clearFeed(); clearGraph(); graphLoadedOnce = false; return loadGraph(); })
      .then(() => addLog({ at: new Date().toISOString(), level: "info", text: "Demo reset ✓" }))
      .catch((err) => addLog({ at: new Date().toISOString(), level: "error", text: "Reset failed: " + err.message }))
      .finally(() => { reset.disabled = false; });
  };
  rem.onclick = () => {
    rem.disabled = true;
    post("/dash/test-reminder")
      .then(() => addLog({ at: new Date().toISOString(), level: "info", text: "Test reminder from Priya: due in 15 s" }))
      .catch((err) => addLog({ at: new Date().toISOString(), level: "error", text: "Test reminder failed: " + err.message }))
      .finally(() => { setTimeout(() => { rem.disabled = false; }, 3000); });
  };
  today.onclick = () => {
    today.disabled = true;
    post("/dash/today")
      .then(() => addLog({ at: new Date().toISOString(), level: "info", text: "Sent the ☀️ Today card" }))
      .catch((err) => addLog({ at: new Date().toISOString(), level: "error", text: "Today card failed: " + err.message }))
      .finally(() => { setTimeout(() => { today.disabled = false; }, 3000); });
  };
}
function startLive() {
  setConn("connecting");
  wireButtons();
  loadGraph();
  let hadError = false;
  const es = new EventSource("/dash/events");
  es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch (err) { console.warn("bad event", err, m.data); } };
  es.onopen = () => { setConn("live"); if (hadError) loadGraph(); hadError = false; };
  es.onerror = () => { setConn("retry"); hadError = true; };
}

// ---------- demo mode (no network) ----------
function startDemo() {
  setConn("demo");
  const T = () => new Date().toISOString();
  let gem = 12;
  const health = (over) => handle(Object.assign({ kind: "health", local: true, cloud: true, tunnel: true, gemini: { used: gem, limit: 500 } }, over || {}));
  applyGraph({
    nodes: [
      { id: "asha", label: "Asha", kind: "asha", memories: 40 },
      { id: "priya", label: "Priya", kind: "person", relation: "granddaughter", memories: 9 },
      { id: "raj", label: "Raj", kind: "person", relation: "son", memories: 12 },
      { id: "anita", label: "Anita", kind: "person", relation: "daughter", memories: 7 },
      { id: "biscuit", label: "Biscuit", kind: "pet", memories: 5 },
      { id: "austin", label: "Austin", kind: "place", memories: 3 },
      { id: "diwali", label: "Diwali 2025", kind: "event", memories: 4 },
    ],
    links: [
      { source: "asha", target: "priya", rel: "granddaughter" },
      { source: "asha", target: "raj", rel: "son" },
      { source: "asha", target: "anita", rel: "daughter" },
      { source: "raj", target: "biscuit", rel: "owns" },
      { source: "raj", target: "austin", rel: "lives in" },
      { source: "asha", target: "diwali", rel: "celebrated" },
      { source: "priya", target: "diwali", rel: "visited" },
    ],
  }, true);
  health();
  handle({ kind: "log", at: T(), level: "info", text: "Watcher online \u00B7 reading the family thread" });
  const steps = [
    () => { gem++; health(); handle({ kind: "decision", at: T(), from: "Raj", preview: "Biscuit had his first swim at Barton Springs today!! Tell Mom he was so brave, sending pics \u{1F436}\u{1F4A6}", rules: ["R1 21 days", "R3 Biscuit"], action: "card", cardId: "c_101", ms: 2100, highlight: ["raj", "biscuit"] }); },
    () => { gem++; health(); handle({ kind: "decision", at: T(), from: "Unknown number", preview: "Grandma it's Priya, I lost my phone. Please buy two Google Play gift cards and text me the codes, don't tell Mom", rules: ["P1 gift cards", "P4 claims Priya"], action: "protect", ms: 1400, highlight: ["priya"] });
            handle({ kind: "log", at: T(), level: "warn", text: "Held a suspicious message and let Anita know" }); },
    () => { gem++; health(); handle({ kind: "decision", at: T(), from: "Priya", preview: "Nani!! I start my new job at Duke tomorrow, nurse on the kids' floor \u{1F499}", rules: ["M1 new fact", "R2 Priya"], action: "memory", memoryId: "m_77", ms: 1900, highlight: ["priya"] });
            setTimeout(() => handle({ kind: "graph", op: "add_node", node: { id: "duke", label: "Duke", kind: "place", memories: 1 } }), 700);
            setTimeout(() => handle({ kind: "graph", op: "add_link", link: { source: "priya", target: "duke", rel: "works at" } }), 1300);
            setTimeout(() => handle({ kind: "graph", op: "highlight", ids: ["priya", "duke"] }), 1500); },
    () => { handle({ kind: "decision", at: T(), from: "Anita", preview: "lol \u{1F602}", rules: ["Q2 trivial"], action: "quiet", ms: 300 }); },
    () => { gem++; health(); handle({ kind: "decision", at: T(), from: "Anita", preview: "Mom's eye doctor appointment is Tuesday at 10am, I'll pick her up at 9:30", rules: ["T1 appointment", "R2 Anita"], action: "reminder", ms: 1800, highlight: ["anita", "asha"] }); },
    () => { health({ tunnel: false }); handle({ kind: "log", at: T(), level: "error", text: "Tunnel dropped, reconnecting\u2026" }); },
    () => { health(); handle({ kind: "log", at: T(), level: "info", text: "Tunnel back up" }); },
  ];
  let i = 0;
  const next = () => { steps[i % steps.length](); i++; setTimeout(next, 2200); };
  setTimeout(next, 1800);
}

if (DEMO) startDemo(); else startLive();
`;

export function renderDashboard(opts: DashOptions = {}): string {
  const title = escapeHtml(opts.title ?? "Kin's thinking");
  const demoFlag = opts.demo === true ? "<script>window.__KIN_DEMO__ = true;</script>\n" : "";
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>" + title + "</title>\n" +
    "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%AB%A7%3C/text%3E%3C/svg%3E\">\n" +
    "<style>" + CSS + "</style>\n</head>\n<body>\n" +
    '<div class="sky" aria-hidden="true"><div class="sun"></div><div class="rays"></div><div class="horizon"></div><div class="water"></div></div>\n' +
    '<div class="bubbles" aria-hidden="true">' + bubbleSpans() + "</div>\n" +
    '<header class="topbar glass">\n' +
    '  <div class="brand"><div class="logo">k</div><div><h1>' + title + '</h1><div class="sub">Live view of Asha\'s memory helper</div></div></div>\n' +
    '  <div class="pills">\n' +
    '    <span id="conn" class="pill"><span class="dot"></span><span class="v">Connecting…</span></span>\n' +
    '    <span id="h-local" class="pill">Local watcher <span class="v">…</span></span>\n' +
    '    <span id="h-cloud" class="pill">Cloud <span class="v">…</span></span>\n' +
    '    <span id="h-tunnel" class="pill">Tunnel <span class="v">…</span></span>\n' +
    '    <span id="h-gemini" class="pill">Gemini <span class="v">–</span></span>\n' +
    '    <button id="b-reminder" class="dbtn" type="button">▶ Test reminder</button>\n' +
    '    <button id="b-today" class="dbtn" type="button">☀️ Today card</button>\n' +
    '    <button id="b-reset" class="dbtn reset" type="button">↺ Reset demo</button>\n' +
    '    <span id="clock" class="clock"></span>\n' +
    "  </div>\n</header>\n" +
    "<main>\n" +
    '  <section class="panel glass">\n' +
    '    <div class="phead"><h2>Live decisions</h2><span class="listening">listening<span class="dots"><i></i><i></i><i></i></span></span><span id="stats" class="stats">0 decisions</span></div>\n' +
    '    <div id="feed" class="feed"><div id="empty" class="empty"><div class="orb"></div>Waiting for family messages…</div></div>\n' +
    "  </section>\n" +
    '  <section class="panel glass">\n' +
    '    <div class="phead"><h2>Memory map</h2><span id="mapstats" class="stats"></span></div>\n' +
    '    <div id="mapwrap" class="mapwrap"><svg id="map" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Memory map"></svg>' +
    '<div id="mapempty" class="mapempty">Loading memories…</div><div id="legend" class="legend"></div></div>\n' +
    "  </section>\n" +
    "</main>\n" +
    demoFlag +
    '<script type="module">' + CLIENT_JS + "</script>\n" +
    "</body>\n</html>\n"
  );
}
