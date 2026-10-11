// "Tablemate's thinking" dashboard: one self-contained HTML document served at /dash (localhost only).
// Polls /dash/state (snapshot) and /dash/events?since= (stream of events) — no SSE, no CDN, no build step.
// Shows: the state-machine strip, members + facts with quotes, filter decisions, live votes/RSVPs,
// the live call panel (call + transcript events), a "simulate message" box and a Reset button.

function bubbleSpans(): string {
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const out: string[] = [];
  for (let i = 0; i < 14; i++) {
    const size = Math.round(14 + rnd() * 70);
    out.push(`<span style="width:${size}px;height:${size}px;left:${(rnd() * 100).toFixed(1)}%;animation-duration:${(20 + rnd() * 22).toFixed(1)}s;animation-delay:${(-rnd() * 40).toFixed(1)}s;opacity:${(0.45 + rnd() * 0.45).toFixed(2)}"></span>`);
  }
  return out.join("");
}

const CSS = String.raw`
:root{--ink:#0a3552;--ink2:#2f6487;--aqua2:#0a86c4;--r:24px}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:ui-rounded,"SF Pro Rounded",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--ink);overflow:hidden;display:flex;flex-direction:column;background:#7fd3f7;-webkit-font-smoothing:antialiased;font-size:16px}
.sky{position:fixed;inset:0;z-index:0;background:linear-gradient(180deg,#36aeee 0%,#79cdf8 20%,#c2ebfd 42%,#f0fbff 52%,#a9e7f3 55.5%,#5fc7df 68%,#2399c1 84%,#0a6893 100%)}
.sun{position:absolute;right:6%;top:-20vh;width:72vh;height:72vh;border-radius:50%;background:radial-gradient(circle,rgba(255,255,236,.95) 0%,rgba(255,250,215,.6) 16%,rgba(255,255,255,.2) 40%,rgba(255,255,255,0) 68%)}
.bubbles{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.bubbles span{position:absolute;bottom:-120px;border-radius:50%;will-change:transform;animation:rise linear infinite;
  background:radial-gradient(circle at 32% 28%,rgba(255,255,255,.95) 0 6%,rgba(255,255,255,.3) 14%,rgba(255,255,255,.05) 48%,rgba(190,240,255,.22) 68%,rgba(255,255,255,.6) 75%,rgba(255,255,255,0) 77%)}
.glass{position:relative;background:linear-gradient(180deg,rgba(255,255,255,.62),rgba(255,255,255,.3));-webkit-backdrop-filter:blur(18px) saturate(1.5);backdrop-filter:blur(18px) saturate(1.5);
  border:1px solid rgba(255,255,255,.82);box-shadow:inset 0 1px 0 rgba(255,255,255,.95),0 20px 44px rgba(4,58,104,.22)}
.topbar{z-index:2;margin:14px 18px 10px;padding:10px 18px;border-radius:24px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:14px}
.logo{width:50px;height:50px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:26px;
  background:radial-gradient(circle at 35% 30%,#fff 0 9%,#b9f2ff 22%,#3cc3f1 55%,#0a74bd 100%);box-shadow:inset 0 -7px 12px rgba(255,255,255,.45),0 7px 16px rgba(0,80,140,.35)}
h1{margin:0;font-size:28px;font-weight:800;color:#08385d;text-shadow:0 1px 0 rgba(255,255,255,.9)}
.sub{font-size:14px;color:var(--ink2);font-weight:600}
.pills{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:.4em;padding:.35em .9em;border-radius:999px;font-size:15px;font-weight:700;white-space:nowrap;color:#4a6378;border:1px solid rgba(255,255,255,.95);
  background:linear-gradient(180deg,rgba(255,255,255,.96) 0%,rgba(236,244,250,.92) 49%,rgba(213,227,238,.92) 50%,rgba(236,244,250,.96) 100%);box-shadow:inset 0 1px 0 #fff,0 3px 8px rgba(0,60,110,.18)}
.pill.ok{color:#0b4d1d;background:linear-gradient(180deg,#ecffec 0%,#b8f3bb 49%,#7cdb88 50%,#a7edae 100%)}
.pill.bad{color:#7a1d12;background:linear-gradient(180deg,#fff1ed 0%,#ffcbc0 49%,#ffa393 50%,#ffc3b7 100%)}
.dbtn{font:inherit;font-size:15px;font-weight:800;padding:.35em 1em;border-radius:999px;cursor:pointer;color:#08385d;border:1px solid rgba(255,255,255,.95);
  background:linear-gradient(180deg,#f2fbff 0%,#c9ecff 49%,#8fd3f7 50%,#bfe8fd 100%);box-shadow:inset 0 1px 0 #fff,0 3px 8px rgba(0,60,110,.2)}
.dbtn.reset{color:#7a1d12;background:linear-gradient(180deg,#fff6f3 0%,#ffd9cf 49%,#ffb4a5 50%,#ffd2c8 100%)}
.clock{font-size:19px;font-weight:800;color:var(--ink2);font-variant-numeric:tabular-nums}
.strip{z-index:2;margin:0 18px 12px;padding:8px;border-radius:20px;display:flex;gap:6px;overflow-x:auto}
.st{flex:1;min-width:92px;text-align:center;padding:8px 6px;border-radius:14px;font-size:14px;font-weight:800;color:#5b7a91;background:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.7);white-space:nowrap}
.st.on{color:#fff;background:linear-gradient(180deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,.1) 50%,rgba(255,255,255,0) 51%),linear-gradient(180deg,#4cc2fa,#1573c6);
  box-shadow:0 0 0 3px rgba(100,210,255,.55),0 6px 14px rgba(0,60,120,.3);text-shadow:0 1px 2px rgba(0,0,0,.3);animation:glow 1.4s ease-in-out infinite alternate}
.st.on.good{background:linear-gradient(180deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,.1) 50%,rgba(255,255,255,0) 51%),linear-gradient(180deg,#5fdc6c,#178a2c)}
.st.on.bad{background:linear-gradient(180deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,.1) 50%,rgba(255,255,255,0) 51%),linear-gradient(180deg,#ffa08c,#d4473a)}
main{position:relative;z-index:1;flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr) minmax(0,1.1fr);gap:14px;padding:0 18px 18px}
.panel{display:flex;flex-direction:column;min-height:0;border-radius:var(--r);overflow:hidden}
.phead{display:flex;align-items:center;gap:10px;padding:12px 18px 6px}
.phead h2{margin:0;font-size:21px;font-weight:800;color:#08385d}
.phead .meta{margin-left:auto;font-size:14px;font-weight:700;color:var(--ink2)}
.scroll{flex:1;min-height:0;overflow-y:auto;padding:4px 14px 14px;scrollbar-width:thin}
.card{padding:10px 12px;margin-bottom:9px;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(236,248,255,.82));border:1px solid #fff;
  box-shadow:inset 0 1px 0 #fff,0 6px 14px rgba(8,70,120,.12);animation:rowIn .5s cubic-bezier(.2,.9,.25,1.15) both}
.sec{font-size:13px;font-weight:900;letter-spacing:.08em;color:#2f6487;text-transform:uppercase;margin:10px 4px 6px}
.mem{display:flex;align-items:center;gap:8px;font-weight:800}
.mem .tag{font-size:12px;font-weight:800;padding:1px 8px;border-radius:999px;background:#e6f4fc;color:#1468ad;border:1px solid #b9dcf1}
.mem .tag.no{background:#fff3e6;color:#8a5a00;border-color:#f2cf7a}
.fact{font-size:15px;line-height:1.35}
.fact b{color:#08385d}
.fact q{color:#21506f;font-style:italic}
.fact .when{color:#5b7a91;font-size:13px;font-weight:700}
.fact .seed{font-size:11px;font-weight:900;padding:1px 7px;border-radius:999px;background:#efe6ff;color:#5a3cc2;margin-left:4px}
.x{float:right;border:0;background:none;color:#b23a2c;font-size:15px;cursor:pointer;font-weight:900}
.opt{display:flex;align-items:center;gap:10px}
.opt .e{font-size:26px}
.opt .n{font-weight:800;font-size:16px}
.opt .w{font-size:13px;color:#1678c2;font-weight:600}
.opt .c{margin-left:auto;font-weight:900;font-size:18px;color:#fff;min-width:30px;height:30px;border-radius:15px;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,#62c0ff,#1468ad)}
.opt.lead{box-shadow:0 0 0 3px rgba(95,220,108,.6),0 6px 14px rgba(8,70,120,.12)}
.small{font-size:13.5px;color:#2f5a78;line-height:1.4}
.flt{font-size:13.5px;padding:4px 10px;margin-bottom:4px;border-radius:10px;background:rgba(255,246,220,.85);color:#7a4a00}
.ev{font-size:13.5px;padding:4px 10px;margin-bottom:4px;border-radius:10px;background:rgba(255,255,255,.6);color:#21506f}
.ev b{color:#0a3552}
.call{font-size:15px;font-weight:800;padding:8px 12px;border-radius:14px;margin-bottom:6px;color:#5c3d00;background:linear-gradient(180deg,#fff8e6,#ffeab8);border:1px solid #f2cf7a}
.bub{max-width:88%;padding:8px 12px;border-radius:16px;margin:4px 0;font-size:15.5px;line-height:1.35;animation:rowIn .4s ease both}
.bub.agent{background:linear-gradient(180deg,#62c0ff,#1f8fe0);color:#fff;margin-left:auto;border-bottom-right-radius:5px}
.bub.restaurant{background:#fff;border:1px solid #d6e9f5;border-bottom-left-radius:5px}
.bub small{display:block;font-size:11px;opacity:.75;font-weight:800}
.log{font-size:13px;padding:4px 10px;margin-bottom:4px;border-radius:10px;background:rgba(255,255,255,.5);color:#2f5a78;overflow-wrap:anywhere}
.log.warn{background:rgba(255,246,220,.8);color:#9c5a00}.log.error{background:rgba(255,232,229,.85);color:#c1242c}
.log.decision{background:rgba(243,236,255,.8);color:#4a2fa8;font-weight:700}
.sim{display:flex;gap:6px;padding:10px 14px 14px;border-top:1px solid rgba(255,255,255,.7)}
.sim select,.sim input{font:inherit;font-size:15px;padding:8px 10px;border-radius:12px;border:1px solid #b9dcf1;background:rgba(255,255,255,.9);color:#0a3552}
.sim input{flex:1;min-width:0}
.empty{padding:30px 10px;text-align:center;color:var(--ink2);font-weight:700}
@keyframes rise{0%{transform:translate3d(0,0,0)}50%{transform:translate3d(-14px,-64vh,0)}100%{transform:translate3d(0,-130vh,0)}}
@keyframes rowIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}
@keyframes glow{from{filter:brightness(1)}to{filter:brightness(1.12)}}
@media (max-width:1200px){main{grid-template-columns:1fr 1fr}#p-call{grid-column:1 / -1}}
`;

// Browser-side code. No backticks or dollar-brace sequences in here (it lives in a String.raw template).
const CLIENT_JS = String.raw`
var $ = function(id){ return document.getElementById(id); };
function el(tag, cls, text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; }
var fmtT = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"short",hour:"numeric",minute:"2-digit"});
var fmtC = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",minute:"2-digit",second:"2-digit"});
setInterval(function(){ $("clock").textContent = fmtC.format(new Date()); }, 1000);
function post(url, body){ return fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})}).then(function(r){return r.json()}); }
function pill(id, ok){ var p=$(id); p.className="pill "+(ok?"ok":"bad"); }

var membersLoaded=false;
function renderState(s){
  pill("h-local", s.health.local); pill("h-cloud", s.health.cloud); pill("h-tunnel", s.health.tunnel);
  $("h-gemini").querySelector(".v").textContent = s.health.gemini.used+"/"+s.health.gemini.limit;
  var cur = s.plan ? s.plan.state : "idle";
  var strip=$("strip"); strip.innerHTML="";
  s.states.forEach(function(st){ var d=el("div","st"+(st===cur?" on"+(st==="booked"?" good":(st==="handed_back"||st==="cancelled")?" bad":""):""), st==="calling"&&s.plan&&s.plan.attempt? "calling["+s.plan.attempt+"]" : st.replace("_"," ")); strip.appendChild(d); });
  if(!membersLoaded){ var sel=$("sim-who"); s.members.forEach(function(m){ var o=el("option",null,m.name); o.value=m.handle; sel.appendChild(o); }); membersLoaded=true; }
  // members + facts
  var mem=$("memory"); mem.innerHTML="";
  s.members.forEach(function(m){
    var c=el("div","card"); var h=el("div","mem"); h.appendChild(el("span",null,m.name));
    h.appendChild(el("span","tag"+(m.cardCapable?"":" no"), m.cardCapable?"📱 gets cards":"✍️ votes by typing")); c.appendChild(h);
    var fs=s.facts.filter(function(f){return f.handle===m.handle});
    if(!fs.length) c.appendChild(el("div","small","No facts yet."));
    fs.forEach(function(f){
      var d=el("div","fact"); d.appendChild(el("b",null,m.name+" · "+f.value)); d.appendChild(document.createTextNode(" · "));
      d.appendChild(el("q",null,f.quote)); d.appendChild(el("span","when"," · "+fmtT.format(new Date(f.saidAt))));
      if(f.source==="demo_seed") d.appendChild(el("span","seed","demo seed"));
      var x=el("button","x","×"); x.title="Forget"; x.onclick=function(){ post("/dash/forget",{id:f.id}).then(refresh); }; d.appendChild(x);
      c.appendChild(d);
    });
    mem.appendChild(c);
  });
  // plan
  var pl=$("plan"); pl.innerHTML="";
  if(!s.plan){ pl.appendChild(el("div","empty","No plan yet. Say “dinner tonight?” in the group.")); $("plan-meta").textContent=""; return; }
  var p=s.plan;
  $("plan-meta").textContent = p.meal+" · "+p.day+" · "+p.chosen+" · by "+p.organizer;
  if(p.statusLine) pl.appendChild(el("div","call",p.statusLine));
  if(p.options.length){
    pl.appendChild(el("div","sec","Options · live votes"));
    var counts=p.options.map(function(){return 0}); p.votes.forEach(function(v){ counts[v.idx]++; });
    var lead=p.view && p.view.leaderIdx;
    p.options.forEach(function(o,i){
      var c=el("div","card opt"+(lead===i?" lead":"")); c.appendChild(el("span","e",o.emoji||"🍽️"));
      var t=el("div"); t.appendChild(el("div","n",(i+1)+". "+o.name)); t.appendChild(el("div","w",o.why)); c.appendChild(t);
      c.appendChild(el("span","c",String(counts[i]))); pl.appendChild(c);
      var who=p.votes.filter(function(v){return v.idx===i}).map(function(v){return v.name+(v.via==="text"?" (typed)":"")}).join(", ");
      if(who) pl.appendChild(el("div","small","  ✓ "+who));
    });
  }
  if(p.view && p.view.skipped) pl.appendChild(el("div","flt",p.view.skipped));
  if(p.rsvps.length){ pl.appendChild(el("div","sec","RSVPs")); pl.appendChild(el("div","small", p.rsvps.map(function(r){return r.name+" "+(r.status==="in"?"✅ in":"❌ out")+(r.time?" · "+r.time:"")}).join(" · "))); }
  if(p.filtered.length){ pl.appendChild(el("div","sec","Filter decisions")); p.filtered.forEach(function(f){ pl.appendChild(el("div","flt",f.name+" — "+f.reason)); }); }
  pl.appendChild(el("div","sec","Transitions"));
  p.events.slice().reverse().forEach(function(e){ var d=el("div","ev"); d.appendChild(el("b",null,e.from_state+" → "+e.to_state)); d.appendChild(document.createTextNode(" · "+e.why)); pl.appendChild(d); });
}

var since=0;
function addLog(cls, text){ var f=$("feed"); var d=el("div","log "+cls,text); f.insertBefore(d,f.firstChild); while(f.children.length>80) f.removeChild(f.lastChild); }
function onEvent(e){
  if(e.kind==="call"){ var c=el("div","call","📞 Call "+e.attempt+" · "+e.phase+" · "+e.detail); $("calls").appendChild(c); $("calls").scrollTop=1e9; $("call-meta").textContent="call "+e.attempt+" · "+e.phase; }
  else if(e.kind==="transcript"){ var b=el("div","bub "+e.role); b.appendChild(el("small",null,e.role==="agent"?"Tablemate (AI)":"Restaurant")); b.appendChild(document.createTextNode(e.text)); $("calls").appendChild(b); $("calls").scrollTop=1e9; }
  else if(e.kind==="decision"){ addLog("decision", e.action.toUpperCase()+" · "+e.from+": “"+e.preview.slice(0,90)+"” ["+e.rules.join(", ")+"]"); }
  else if(e.kind==="log"){ addLog(e.level, e.text); }
  else if(e.kind==="message"){ addLog("", "💬 "+e.name+": "+e.text); }
  else if(e.kind==="filter"){ addLog("warn", "filter · "+e.name+" — "+e.reason); }
}
function pollEvents(){
  fetch("/dash/events?since="+since).then(function(r){return r.json()}).then(function(j){
    if(j.seq<since){ since=0; }
    j.events.forEach(onEvent); since=j.seq;
  }).catch(function(){});
}
function refresh(){ fetch("/dash/state").then(function(r){return r.json()}).then(renderState).catch(function(){}); }
refresh(); pollEvents();
setInterval(refresh, 1500); setInterval(pollEvents, 1000);

$("reset").onclick=function(){ if(!confirm("Reset the demo? Plans, votes, messages and facts are cleared.")) return; post("/dash/reset").then(function(){ $("calls").innerHTML=""; $("feed").innerHTML=""; since=0; refresh(); }); };
$("sim").onsubmit=function(ev){ ev.preventDefault(); var t=$("sim-text").value.trim(); if(!t) return;
  post("/dash/simulate",{handle:$("sim-who").value,text:t}).then(function(j){ if(!j.ok) alert(j.error||"failed"); }); $("sim-text").value=""; };
`;

export function renderDashboard(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tablemate's thinking</title><style>${CSS}</style></head><body>
<div class="sky"><div class="sun"></div></div><div class="bubbles">${bubbleSpans()}</div>
<div class="topbar glass">
  <div class="brand"><div class="logo">🍽️</div><div><h1>Tablemate's thinking</h1><div class="sub">Gemini extracts · plain code decides · nothing books without the organizer's ✅</div></div></div>
  <div class="pills">
    <span class="pill" id="h-local">Group (local) <span class="v"></span></span>
    <span class="pill" id="h-cloud">Cloud line <span class="v"></span></span>
    <span class="pill" id="h-tunnel">Tunnel <span class="v"></span></span>
    <span class="pill" id="h-gemini">Gemini <span class="v">0/0</span></span>
    <button class="dbtn reset" id="reset">Reset demo</button>
    <span class="clock" id="clock"></span>
  </div>
</div>
<div class="strip glass" id="strip"></div>
<main>
  <section class="panel glass"><div class="phead"><h2>🧠 Group memory</h2><span class="meta">from the chat, with quotes</span></div>
    <div class="scroll" id="memory"></div>
    <form class="sim" id="sim"><select id="sim-who"></select><input id="sim-text" placeholder="Simulate a group message…" autocomplete="off"><button class="dbtn">Send</button></form>
  </section>
  <section class="panel glass"><div class="phead"><h2>🗳️ The plan</h2><span class="meta" id="plan-meta"></span></div>
    <div class="scroll" id="plan"></div>
  </section>
  <section class="panel glass" id="p-call"><div class="phead"><h2>📞 Live call</h2><span class="meta" id="call-meta">no call yet</span></div>
    <div class="scroll" id="calls" style="flex:1.4"></div>
    <div class="phead"><h2 style="font-size:17px">Activity</h2></div>
    <div class="scroll" id="feed"></div>
  </section>
</main>
<script>${CLIENT_JS}</script></body></html>`;
}
