// Card page renderer (v2: simpler). Designed for the Spectrum webview: 280×300 when opened, 149×58 in the bubble.
// One idea per screen: who + what on the main screen, replies on their own screen. Same three utility buttons everywhere.
export type CardType = "context" | "protect" | "reminder" | "whois" | "info";
export interface CardButton { id: string; label: string; style?: "green" | "blue" | "red" | "plain"; action: string; payload?: Record<string, unknown> }
export interface CardView {
  id: string; type: CardType; state: string; version: number; token: string;
  title: string; subtitle?: string | null; photoUrl?: string | null; emoji?: string | null;
  line?: string | null; quoteFrom?: string | null; quote?: string | null; summary?: string | null;
  status?: { text: string; tone: "ok" | "info" | "warn" } | null;
  buttons: CardButton[]; readAloud?: boolean; talk?: boolean;
}

export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const e = escapeHtml;

const THEME: Record<CardType, { band: string; ring: string; accent: string }> = {
  context: { band: "linear-gradient(180deg,#e3f7ff 0%,#a9e4ff 55%,#7fd3fb 100%)", ring: "#4fb8ef", accent: "#1678c2" },
  whois: { band: "linear-gradient(180deg,#e3f7ff 0%,#a9e4ff 55%,#7fd3fb 100%)", ring: "#4fb8ef", accent: "#1678c2" },
  info: { band: "linear-gradient(180deg,#e9fbff 0%,#bdeefa 55%,#93e0f2 100%)", ring: "#4cc3dd", accent: "#137f99" },
  protect: { band: "linear-gradient(180deg,#fff1ee 0%,#ffd3cc 55%,#ffb9ae 100%)", ring: "#f08a7c", accent: "#b23a2c" },
  reminder: { band: "linear-gradient(180deg,#effff0 0%,#c8f5c9 55%,#a3ea9f 100%)", ring: "#5ccc63", accent: "#1d8a32" },
};

function avatar(v: CardView, size: number): string {
  const inner = v.photoUrl
    ? `<img src="${e(v.photoUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : `<span style="font-size:${Math.round(size * 0.52)}px;line-height:1">${e(v.emoji || v.title.slice(0, 1))}</span>`;
  return `<div class="av" style="width:${size}px;height:${size}px">${inner}</div>`;
}

function utilRow(v: CardView, extra: string[] = []): string {
  const items = [...extra];
  if (v.readAloud) items.push(`<button class="u" data-listen="1">🔊<span>Listen</span></button>`);
  if (v.talk) items.push(`<button class="u" data-talk="1">🎙️<span>Talk to Kin</span></button>`);
  return items.length ? `<div class="row">${items.join("")}</div>` : "";
}

export function renderCard(v: CardView): string {
  const th = THEME[v.type] ?? THEME.context;
  const replies = v.buttons.filter((b) => b.action === "reply");
  const know = v.buttons.find((b) => b.action === "know"); // "I know Priya" lives on the reply screen only
  const others = v.buttons.filter((b) => b.action !== "reply" && b.action !== "know");
  const first = v.title.split(" ")[0];
  const glyph = v.state === "done" || v.state === "replied" || v.state === "confirmed_safe" ? "✅" : v.type === "protect" ? "🛡️" : v.type === "reminder" ? "💊" : "💬";

  // ---------- main screen ----------
  let body = "";
  if (v.type === "reminder") {
    body += v.line ? `<div class="big opt-keep">${e(v.line)}</div>` : "";
  } else {
    if (v.line) body += `<div class="line" data-opt="3">${e(v.line)}</div>`;
    if (v.summary) body += `<div class="explain" data-opt="1">${e(v.summary)}</div>`;
    if (v.quote) body += `<div class="quote" data-opt="2"><b>${e(v.quoteFrom || "The message:")}</b> ${e(v.quote)}</div>`;
  }
  if (v.status) body += `<div class="status ${v.status.tone}">${e(v.status.text)}</div>`;

  let actions = "";
  if (!v.status) {
    if (replies.length) actions += `<button class="p green" data-screen="reply">💬 Reply to ${e(first)}</button>`;
    if (v.type === "reminder") {
      const done = others.find((b) => b.action === "done");
      const later = others.find((b) => b.action === "snooze");
      if (done) actions += `<button class="p green" data-act="done">✅ Done</button>`;
      actions += utilRow(v, later ? [`<button class="u" data-act="snooze">⏰<span>Later</span></button>`] : []).replace(`data-talk="1">🎙️<span>Talk to Kin</span>`, `data-talk="1">🎙️<span>Talk</span>`);
    } else {
      const cancel = others.find((b) => b.action === "cancel");
      for (const b of others.filter((b) => b !== cancel).slice(0, 1)) actions += `<button class="p ${b.style === "green" ? "green" : "blue"}" data-act="${e(b.action)}" data-payload="${e(JSON.stringify(b.payload ?? {}))}">${e(b.label)}</button>`;
      actions += utilRow(v, cancel ? [`<button class="u" data-act="cancel">${e(cancel.label)}</button>`] : []);
    }
  } else {
    actions += utilRow(v);
  }

  const main = `<section id="main" class="screen">
  <header>${avatar(v, 50)}<div class="who"><h1${v.title.length > 12 ? ` style="font-size:${v.title.length > 17 ? 19 : 22}px"` : ""}>${e(v.title)}</h1>${v.subtitle ? `<h2>${e(v.subtitle)}</h2>` : ""}</div></header>
  <div class="body">${body}</div>
  <div class="actions">${actions}</div>
</section>`;

  // ---------- reply screen ----------
  const replyScreen = replies.length && !v.status ? `<section id="reply" class="screen" hidden>
  <header>${avatar(v, 40)}<div class="who"><h1 class="sm">Reply to ${e(first)}</h1><h2>Tap one to send it</h2></div></header>
  <div class="replies">${replies.slice(0, 3).map((b) => `<button class="p green r" data-act="reply" data-payload="${e(JSON.stringify(b.payload ?? {}))}">${e(b.label)}</button>`).join("")}</div>
  <div class="brow"><button class="back" data-screen="main">← Back</button>${know ? `<button class="back know" data-act="know" data-payload="${e(JSON.stringify(know.payload ?? {}))}">${e(know.label)}</button>` : ""}</div>
</section>` : "";

  const compact = `<div id="compact">${avatar(v, 40)}<div class="ct">${e(v.title)}</div><div class="cg">${glyph}</div></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta property="og:title" content="${e(v.title)}"><meta property="og:description" content="${e(v.line || v.subtitle || "")}">
<title>${e(v.title)}</title>
<style>
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;overflow:hidden}
body{font-family:-apple-system,"SF Pro Rounded",system-ui,sans-serif;color:#0b2a4a;background:#fff;-webkit-text-size-adjust:100%}
#wrap{width:280px;height:300px;transform-origin:0 0;position:relative;overflow:hidden;background:linear-gradient(180deg,#ffffff 0%,#f4fbff 100%)}
.screen{position:absolute;inset:0;display:flex;flex-direction:column}
.screen[hidden]{display:none}
header{display:flex;align-items:center;gap:10px;padding:9px 12px 8px;background:${th.band};position:relative;overflow:hidden;
  box-shadow:inset 0 1px 0 #fff,0 1px 0 rgba(11,42,74,.08)}
header::before{content:"";position:absolute;left:0;right:0;top:0;height:50%;background:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,0))}
header::after{content:"";position:absolute;right:-14px;top:-18px;width:70px;height:70px;border-radius:50%;
  background:radial-gradient(circle at 35% 35%,rgba(255,255,255,.9),rgba(255,255,255,.15) 60%,transparent 70%)}
.av{flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;position:relative;z-index:1;
  background:radial-gradient(circle at 35% 30%,#fff 0 12%,#e8f7ff 30%,#bfe6fb 100%);border:2px solid ${th.ring};box-shadow:0 2px 6px rgba(0,60,120,.2)}
.who{min-width:0;position:relative;z-index:1}
h1{font-size:25px;line-height:1.05;font-weight:800;letter-spacing:-.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1.sm{font-size:21px}
h2{font-size:15px;font-weight:600;margin-top:2px;color:#123a5e}
.body{flex:1;min-height:0;padding:7px 12px 0;display:flex;flex-direction:column;gap:5px;overflow:hidden}
.body>*{flex-shrink:0}
.line{font-size:16px;font-weight:700;line-height:1.22;color:${th.accent};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.explain{font-size:15px;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.quote{font-size:15px;line-height:1.25;max-height:calc(2.5em + 12px);background:#eef7fd;border:1px solid #cfe6f5;border-radius:12px;padding:5px 9px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.quote b{color:#123a5e}
.big{font-size:22px;font-weight:800;line-height:1.2;text-align:center;padding:10px 8px;border-radius:14px;background:#effbef;border:1px solid #bfe8c1;color:#0f4d1d}
.status{font-size:17px;font-weight:800;line-height:1.25;text-align:center;padding:9px 10px;border-radius:14px}
.status.ok{background:linear-gradient(180deg,#eaffea,#c9f3cb);border:1px solid #9edfa3;color:#0f4d1d}
.status.info{background:linear-gradient(180deg,#eef8ff,#d3ecfb);border:1px solid #a9d6f2;color:#0b3a66}
.status.warn{background:linear-gradient(180deg,#fff8e6,#ffeab8);border:1px solid #f2cf7a;color:#5c3d00}
.actions{padding:6px 10px 9px;display:flex;flex-direction:column;gap:6px}
button{font-family:inherit;border:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.p{width:100%;min-height:46px;border-radius:999px;font-size:18px;font-weight:800;color:#fff;padding:0 12px;position:relative;overflow:hidden;
  text-shadow:0 1px 1px rgba(0,0,0,.25);box-shadow:0 3px 8px rgba(0,50,90,.25),inset 0 -2px 4px rgba(0,0,0,.12)}
.p::before{content:"";position:absolute;left:6%;right:6%;top:2px;height:48%;border-radius:999px;background:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,.08))}
.green{background:linear-gradient(180deg,#5fdc6c 0%,#24ad3c 55%,#178a2c 100%)}
.blue{background:linear-gradient(180deg,#62c0ff 0%,#1f8fe0 55%,#1468ad 100%)}
.row{display:flex;gap:6px}
.u{flex:1;min-height:40px;border-radius:14px;font-size:17px;font-weight:700;color:#0b2a4a;display:flex;align-items:center;justify-content:center;gap:5px;
  background:linear-gradient(180deg,#ffffff 0%,#e6f4fc 60%,#d3ebf8 100%);border:1px solid #b9dcf1;box-shadow:0 2px 4px rgba(0,50,90,.12),inset 0 1px 0 #fff}
.u span{font-size:15px}
.replies{flex:1;padding:8px 12px 0;display:flex;flex-direction:column;gap:7px;justify-content:center}
.r{min-height:44px;font-size:17px}
.brow{display:flex;gap:6px;margin:6px 12px 9px}
.back{flex:1;min-width:0;min-height:36px;border-radius:12px;font-size:16px;font-weight:700;color:#0b2a4a;background:#eef6fb;border:1px solid #c9e2f2}
.back.know{flex:1.6;font-size:15px;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button:disabled{opacity:.55}
#toast{position:absolute;left:10px;right:10px;bottom:10px;z-index:9;display:none;text-align:center;font-size:17px;font-weight:800;padding:12px;border-radius:14px;
  background:#0b2a4a;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25)}
#compact{display:none}
@media (max-height:120px){
  #wrap{display:none}
  #compact{display:flex;align-items:center;gap:6px;height:100vh;padding:0 6px;background:${th.band}}
  #compact .av{width:34px!important;height:34px!important;border-width:1.5px}
  #compact .av span{font-size:18px!important}
  .ct{flex:1;min-width:0;font-size:15px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cg{font-size:16px}
}
</style></head><body>
<div id="wrap">${main}${replyScreen}<div id="toast"></div></div>
${compact}
<script>
(function(){
  var ID=${JSON.stringify(v.id)}, T=${JSON.stringify(v.token)}, V=${JSON.stringify(v.version)};
  var wrap=document.getElementById("wrap");
  function scale(){ var s=Math.min(innerWidth/280, innerHeight/300); if(s>0&&isFinite(s)){ wrap.style.transform="scale("+s+")"; } }
  scale(); addEventListener("resize", scale);
  // fit: hide optional lines (lowest priority first) until the main screen fits
  function fit(){ var m=document.querySelector("#main .body"); if(!m) return; var opts=[].slice.call(m.querySelectorAll("[data-opt]")).sort(function(a,b){return a.dataset.opt-b.dataset.opt});
    for(var i=0;i<opts.length && m.scrollHeight>m.clientHeight+1;i++){ opts[i].style.display="none"; } }
  fit();
  if(location.hash==="#reply"&&document.getElementById("reply")) go("reply");
  try{ fetch("/diag",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({page:"card",id:ID,w:innerWidth,h:innerHeight})}); }catch(e){}
  var toast=document.getElementById("toast");
  function show(t){ toast.textContent=t; toast.style.display="block"; }
  function busy(on){ [].forEach.call(document.querySelectorAll("button"),function(b){b.disabled=on}); }
  function go(screen){ [].forEach.call(document.querySelectorAll(".screen"),function(s){ s.hidden = s.id!==screen; }); }
  var audio=null;
  function listenLabel(b, playing){ b.innerHTML = playing ? "⏹<span>Stop</span>" : "🔊<span>Listen</span>"; }
  function listen(b){
    if(audio && !audio.paused){ audio.pause(); audio.currentTime=0; listenLabel(b,false); toast.style.display="none"; return; }
    if(!audio){ audio=new Audio("/card/"+ID+"/audio?t="+T); audio.preload="auto"; }
    show("Reading it to you… 🔊"); listenLabel(b,true);
    audio.onended=function(){ listenLabel(b,false); toast.style.display="none"; };
    audio.onplaying=function(){ setTimeout(function(){ toast.style.display="none"; }, 1500); };
    var p=audio.play();
    if(p&&p.catch) p.catch(function(err){
      // audio blocked in this view → fall back to a voice message in the thread
      listenLabel(b,false);
      try{ fetch("/diag",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({page:"card",id:ID,ev:"listen-fail",msg:String(err&&err.name)})}); }catch(e){}
      fetch("/card/"+ID+"/act",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t:T,v:V,action:"readaloud",payload:{}})});
      show("I'm sending it as a voice message 🔊"); setTimeout(function(){toast.style.display="none"},2500);
    });
  }
  document.addEventListener("click", function(ev){
    var b=ev.target.closest("button"); if(!b||b.disabled) return;
    if(b.dataset.listen){ listen(b); return; }
    if(b.dataset.screen){ go(b.dataset.screen); return; }
    if(b.dataset.talk){ location.href="/talk/"+ID+"?t="+T; return; }
    var act=b.dataset.act; if(!act) return;
    var payload={}; try{ payload=JSON.parse(b.dataset.payload||"{}"); }catch(e){}
    busy(true); show(act==="readaloud" ? "Sending you a voice message 🔊" : "One moment…");
    fetch("/card/"+ID+"/act",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t:T,v:V,action:act,payload:payload})})
      .then(function(r){return r.json()}).then(function(j){
        if(j&&j.ok){ if(j.toast) show(j.toast); if(act==="readaloud"){ setTimeout(function(){ toast.style.display="none"; busy(false); }, 2500); } else { setTimeout(function(){ location.reload(); }, 1100); } }
        else { show((j&&j.toast)||"That didn't work. Please try again."); busy(false); setTimeout(function(){toast.style.display="none"},2500); }
      }).catch(function(){ show("That didn't work. Please try again."); busy(false); setTimeout(function(){toast.style.display="none"},2500); });
  });
})();
</script></body></html>`;
}
