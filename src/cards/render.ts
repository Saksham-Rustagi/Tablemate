// Plan card page for the Spectrum webview: 280×300 when opened, 149×58 in the bubble. Kin's glossy Frutiger Aero CSS.
// One page per member (their token); the screen follows the plan state. Plain inline ES5 JS, no build step.
// Open pages poll /plan/:id/state every 2 s (quick tunnels don't do SSE) and reload when the plan's rev changes.
import type { PlanView } from "../plan";

export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const e = escapeHtml;

type Theme = { band: string; ring: string; accent: string };
const BLUE: Theme = { band: "linear-gradient(180deg,#e3f7ff 0%,#a9e4ff 55%,#7fd3fb 100%)", ring: "#4fb8ef", accent: "#1678c2" };
const GREEN: Theme = { band: "linear-gradient(180deg,#effff0 0%,#c8f5c9 55%,#a3ea9f 100%)", ring: "#5ccc63", accent: "#1d8a32" };
const AMBER: Theme = { band: "linear-gradient(180deg,#fffaea 0%,#ffeab8 55%,#ffd98a 100%)", ring: "#f0b94c", accent: "#8a5a00" };
const CORAL: Theme = { band: "linear-gradient(180deg,#fff1ee 0%,#ffd3cc 55%,#ffb9ae 100%)", ring: "#f08a7c", accent: "#b23a2c" };

function av(glyph: string, size: number, photo?: string | null): string {
  const inner = photo
    ? `<img src="${e(photo)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : `<span style="font-size:${Math.round(size * 0.55)}px;line-height:1">${e(glyph)}</span>`;
  return `<div class="av" style="width:${size}px;height:${size}px">${inner}</div>`;
}
function header(glyph: string, title: string, sub: string, photo?: string | null): string {
  return `<header>${av(glyph, 36, photo)}<div class="who"><h1${title.length > 18 ? ` style="font-size:${title.length > 24 ? 15 : 17}px"` : ""}>${e(title)}</h1><h2>${e(sub)}</h2></div></header>`;
}
const act = (a: string, extra: Record<string, unknown> = {}) => `data-act="${e(a)}" data-payload="${e(JSON.stringify(extra))}"`;

function screen(v: PlanView): { theme: Theme; html: string; glyph: string; compact: string } {
  const org = v.me.isOrganizer;
  switch (v.state) {
    case "offered":
      return {
        theme: BLUE, glyph: "🍽️", compact: `${v.title}?`,
        html: header("🍽️", `${v.title}?`, "Want me to find spots near campus?") +
          `<div class="body center"><div class="line">I'll pick 3 places that fit everyone in the group.</div></div>
          <div class="actions">${org ? `<button class="p green" ${act("offer_yes")}>👍 Find spots</button><button class="u" ${act("offer_no")}>Not now</button>` : `<div class="hint">Waiting for ${e(v.organizerName)}</div>`}</div>`,
      };
    case "voting": {
      const rows = v.options.map((o) => `<button class="opt${o.mine ? " mine" : ""}${v.leaderIdx === o.idx ? " lead" : ""}" ${act("vote", { idx: o.idx })}>
        ${av(o.emoji, 34, o.photo)}<span class="ot"><b>${o.idx + 1}. ${e(o.name)}</b><i>${e(o.meta)}</i><em data-opt="1">${e(o.why)}</em></span>
        <span class="vc">${o.mine ? "✓" : ""}${o.votes ? `<s>${o.votes}</s>` : ""}</span></button>`).join("");
      const chips = v.chips.map((c) => `<button class="chip${c.chosen ? " on" : ""}${c.mine ? " mine" : ""}" ${act("time", { time: c.time })}>${e(c.label)}</button>`).join("");
      const rsvp = org ? "" : `<button class="chip in${v.myRsvp === "in" ? " on" : ""}" ${act("rsvp", { status: "in" })}>I'm in</button><button class="chip out${v.myRsvp === "out" ? " on" : ""}" ${act("rsvp", { status: "out" })}>Can't</button>`;
      const book = org
        ? `<button class="p green sm" ${act("book")}${v.canBook ? "" : " disabled"}>${e(v.bookLabel)}</button>`
        : `<div class="hint">${e(v.votingClosed ? `Voting closed · ${v.organizerName} books` : `Tap to vote · ${v.organizerName} books`)}</div>`;
      return {
        theme: BLUE, glyph: "🍽️", compact: v.leaderIdx != null ? `${v.options[v.leaderIdx].name} leads` : v.title,
        html: header("🍽️", v.title, `${v.inCount} in · ${v.chosenLabel}${v.votingClosed ? " · voting closed" : ""}`) +
          `<div class="body">${rows}${v.skipped ? `<div class="skip" data-opt="2">${e(v.skipped)}</div>` : ""}<div class="ctl">${rsvp}${chips}</div></div>
          <div class="actions">${book}</div>`,
      };
    }
    case "booking":
    case "calling":
      return {
        theme: AMBER, glyph: "📞", compact: `Calling ${v.calling?.name ?? "…"}`,
        html: header("📞", `Calling ${v.calling?.name ?? "…"}`, `${v.chosenLabel} · table for ${v.inCount}`) +
          `<div class="body center"><div class="ring">📞</div><div class="line">${e(v.statusLine || `Asking ${v.calling?.name ?? "them"} for a table…`)}</div>
          <div class="hint">Call ${v.attempt} of 3 · I'm an AI assistant and I say so</div></div>
          <div class="actions">${org ? `<button class="u" ${act("cancel")}>Cancel plan</button>` : ""}</div>`,
      };
    case "asking_group": {
      const a = v.ask!;
      return {
        theme: AMBER, glyph: "🤔", compact: `${v.calling?.name ?? "They"}: ${a.label ?? "other time"}`,
        html: header("🤔", `${v.calling?.name ?? "They"} offered ${a.label ?? "another time"}`, `You wanted ${v.chosenLabel}`) +
          `<div class="body center"><div class="line">That's outside your window, so I didn't take it.</div>
          <div class="hint">${org ? "Your call:" : `${e(v.organizerName)} decides · your tap counts as a vote`}${a.take || a.next ? ` · take ${a.take} · next ${a.next}` : ""}</div></div>
          <div class="actions">${a.time ? `<button class="p green" ${act("take_time")}>Take ${e(a.label!)}</button>` : ""}${a.canTryNext ? `<button class="p blue" ${act("try_next")}>Try next place</button>` : `<button class="p blue" ${act("try_next")}>Give me the numbers</button>`}</div>`,
      };
    }
    case "booked": {
      const b = v.booked!;
      const confetti = Array.from({ length: 18 }, (_, i) => `<i style="left:${(i * 53) % 100}%;animation-delay:${((i * 37) % 20) / 10}s;background:${["#ff6b6b", "#ffd93d", "#6bcB77", "#4d96ff", "#c77dff"][i % 5]}"></i>`).join("");
      return {
        theme: GREEN, glyph: "✅", compact: `✅ ${b.name} ${b.timeLabel}`,
        html: `<div class="confetti">${confetti}</div>` + header(b.emoji || "✅", `✅ ${b.name}`, `${b.timeLabel} · table for ${b.party}`) +
          `<div class="body center"><div class="big">${e(b.timeLabel)}</div><div class="line">Table for ${b.party} · under ${e(b.under ?? "")}</div>
          <a class="addr" href="${e(b.mapsUri)}" target="_blank">📍 ${e(b.address)}</a></div>
          <div class="actions"><a class="p blue link" href="${e(b.icsUrl)}">📅 Add to calendar</a></div>`,
      };
    }
    case "handed_back":
      return {
        theme: CORAL, glyph: "☎️", compact: "Numbers to call",
        html: header("☎️", "I couldn't get a table", "Here are the numbers:") +
          `<div class="body">${v.statusLine ? `<div class="hint">${e(v.statusLine)}</div>` : ""}${v.numbers.map((n) => `<a class="opt tel" href="tel:${e(n.phone)}"><span class="ot"><b>${e(n.name)}</b><i>${e(n.phone)}</i></span><span class="vc">📞</span></a>`).join("")}</div>`,
      };
    default:
      return {
        theme: BLUE, glyph: "🍽️", compact: v.state === "cancelled" ? "Plan cancelled" : "No plan",
        html: header("🍽️", v.title, v.state === "cancelled" ? "Plan cancelled" : "No plan for now") +
          `<div class="body center"><div class="line">${e(v.statusLine || (v.state === "cancelled" ? "This plan was cancelled." : "I'll stay quiet."))}</div></div>`,
      };
  }
}

export function renderPlanPage(v: PlanView): string {
  const s = screen(v);
  const th = s.theme;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta property="og:title" content="${e(v.title)}"><meta property="og:description" content="Tablemate">
<title>${e(v.title)}</title>
<style>
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;overflow:hidden}
body{font-family:-apple-system,"SF Pro Rounded",system-ui,sans-serif;color:#0b2a4a;background:#fff;-webkit-text-size-adjust:100%}
#wrap{width:280px;height:300px;transform-origin:0 0;position:relative;overflow:hidden;display:flex;flex-direction:column;background:linear-gradient(180deg,#ffffff 0%,#f4fbff 100%)}
header{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;background:${th.band};position:relative;overflow:hidden;box-shadow:inset 0 1px 0 #fff,0 1px 0 rgba(11,42,74,.08)}
header::before{content:"";position:absolute;left:0;right:0;top:0;height:50%;background:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,0))}
header::after{content:"";position:absolute;right:-14px;top:-18px;width:64px;height:64px;border-radius:50%;background:radial-gradient(circle at 35% 35%,rgba(255,255,255,.9),rgba(255,255,255,.15) 60%,transparent 70%)}
.av{flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;position:relative;z-index:1;
  background:radial-gradient(circle at 35% 30%,#fff 0 12%,#e8f7ff 30%,#bfe6fb 100%);border:2px solid ${th.ring};box-shadow:0 2px 5px rgba(0,60,120,.2)}
.who{min-width:0;position:relative;z-index:1}
h1{font-size:19px;line-height:1.1;font-weight:800;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h2{font-size:13px;font-weight:600;margin-top:1px;color:#123a5e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.body{flex:1;min-height:0;padding:5px 8px 0;display:flex;flex-direction:column;gap:4px;overflow:hidden}
.body>*{flex-shrink:0}
.body.center{justify-content:center;align-items:center;text-align:center;gap:6px}
button,a.p,a.opt{font-family:inherit;border:0;cursor:pointer;-webkit-tap-highlight-color:transparent;text-decoration:none}
.opt{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:4px 7px;border-radius:13px;color:#0b2a4a;
  background:linear-gradient(180deg,#ffffff 0%,#eef8fe 60%,#e0f1fb 100%);border:1px solid #c6e3f4;box-shadow:0 1px 3px rgba(0,50,90,.12),inset 0 1px 0 #fff}
.opt.mine{border-color:${th.ring};box-shadow:0 0 0 2px ${th.ring}55,inset 0 1px 0 #fff;background:linear-gradient(180deg,#f4fbff,#d7efff)}
.opt .av{border-width:1.5px}
.ot{flex:1;min-width:0;display:flex;flex-direction:column}
.ot b{font-size:14px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ot i,.ot em{font-style:normal;font-size:11.5px;line-height:1.2;color:#2f6487;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ot em{color:${th.accent};font-weight:600}
.vc{flex:none;display:flex;align-items:center;gap:3px;font-weight:900;color:${th.accent};font-size:15px}
.vc s{text-decoration:none;min-width:20px;height:20px;border-radius:10px;font-size:12px;color:#fff;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(180deg,#62c0ff,#1468ad);box-shadow:inset 0 1px 0 rgba(255,255,255,.6)}
.skip{font-size:11.5px;font-weight:600;color:#7a4a00;background:#fff6dc;border:1px solid #f2dca0;border-radius:9px;padding:2px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ctl{display:flex;gap:4px}
.chip{flex:1;min-width:0;min-height:28px;border-radius:999px;font-size:12.5px;font-weight:800;color:#0b2a4a;padding:0 4px;white-space:nowrap;
  background:linear-gradient(180deg,#ffffff 0%,#e6f4fc 60%,#d3ebf8 100%);border:1px solid #b9dcf1}
.chip.on{color:#fff;background:linear-gradient(180deg,#62c0ff 0%,#1f8fe0 55%,#1468ad 100%);border-color:#1468ad}
.chip.in.on{background:linear-gradient(180deg,#5fdc6c 0%,#24ad3c 55%,#178a2c 100%);border-color:#178a2c}
.chip.out.on{background:linear-gradient(180deg,#ffa08c,#e65e4c);border-color:#c94a3a}
.chip.mine:not(.on){border-color:${th.ring};border-width:2px}
.actions{flex:none;padding:5px 8px 8px;display:flex;flex-direction:column;gap:5px}
.p{display:flex;align-items:center;justify-content:center;width:100%;min-height:40px;border-radius:999px;font-size:16px;font-weight:800;color:#fff;padding:0 10px;position:relative;overflow:hidden;
  text-shadow:0 1px 1px rgba(0,0,0,.25);box-shadow:0 3px 8px rgba(0,50,90,.25),inset 0 -2px 4px rgba(0,0,0,.12);white-space:nowrap}
.p.sm{min-height:34px;font-size:14.5px}
.p::before{content:"";position:absolute;left:6%;right:6%;top:2px;height:48%;border-radius:999px;background:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,.08))}
.green{background:linear-gradient(180deg,#5fdc6c 0%,#24ad3c 55%,#178a2c 100%)}
.blue{background:linear-gradient(180deg,#62c0ff 0%,#1f8fe0 55%,#1468ad 100%)}
.u{width:100%;min-height:34px;border-radius:14px;font-size:15px;font-weight:700;color:#0b2a4a;
  background:linear-gradient(180deg,#ffffff 0%,#e6f4fc 60%,#d3ebf8 100%);border:1px solid #b9dcf1;box-shadow:0 2px 4px rgba(0,50,90,.12),inset 0 1px 0 #fff}
.line{font-size:15px;font-weight:700;line-height:1.25;color:${th.accent}}
.hint{font-size:12.5px;font-weight:600;color:#2f6487;text-align:center}
.big{font-size:38px;font-weight:900;color:#0f4d1d;letter-spacing:-1px;text-shadow:0 1px 0 #fff}
.addr{font-size:13px;font-weight:700;color:#1468ad;text-decoration:none;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ring{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;
  background:radial-gradient(circle at 35% 30%,#fff 0 12%,#fff1cc 35%,#ffd36b 100%);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(240,185,76,.6)}50%{box-shadow:0 0 0 14px rgba(240,185,76,0)}}
.confetti{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:5}
.confetti i{position:absolute;top:-12px;width:7px;height:11px;border-radius:2px;opacity:.9;animation:fall 2.6s ease-in 2 forwards}
@keyframes fall{to{transform:translateY(330px) rotate(540deg);opacity:.2}}
button:disabled{opacity:.5}
#toast{position:absolute;left:10px;right:10px;bottom:10px;z-index:9;display:none;text-align:center;font-size:15px;font-weight:800;padding:10px;border-radius:14px;
  background:#0b2a4a;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25)}
#compact{display:none}
@media (max-height:120px){
  #wrap{display:none}
  #compact{display:flex;align-items:center;gap:6px;height:100vh;padding:0 6px;background:${th.band}}
  .ct{flex:1;min-width:0;font-size:14px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
}
</style></head><body>
<div id="wrap">${s.html}<div id="toast"></div></div>
<div id="compact">${av(s.glyph, 32)}<div class="ct">${e(s.compact)}</div></div>
<script>
(function(){
  var ID=${JSON.stringify(v.planId)}, T=${JSON.stringify(v.token)}, REV=${JSON.stringify(v.rev)};
  var wrap=document.getElementById("wrap");
  function scale(){ var s=Math.min(innerWidth/280, innerHeight/300); if(s>0&&isFinite(s)){ wrap.style.transform="scale("+s+")"; } }
  scale(); addEventListener("resize", scale);
  // fit: hide optional lines (lowest priority first) until the body fits
  function fit(){ var m=document.querySelector(".body"); if(!m) return; var opts=[].slice.call(m.querySelectorAll("[data-opt]")).sort(function(a,b){return a.getAttribute("data-opt")-b.getAttribute("data-opt")});
    var i=0; while(i<opts.length && m.scrollHeight>m.clientHeight+1){ var k=opts[i].getAttribute("data-opt"); while(i<opts.length && opts[i].getAttribute("data-opt")===k){ opts[i].style.display="none"; i++; } } }
  fit();
  var toast=document.getElementById("toast");
  function show(t){ toast.textContent=t; toast.style.display="block"; }
  function hide(){ toast.style.display="none"; }
  function busy(on){ [].forEach.call(document.querySelectorAll("button"),function(b){ if(on){ b.setAttribute("data-was",b.disabled?"1":""); b.disabled=true; } else { b.disabled=b.getAttribute("data-was")==="1"; } }); }
  var acting=false;
  document.addEventListener("click", function(ev){
    var b=ev.target.closest ? ev.target.closest("button") : null; if(!b||b.disabled) return;
    var a=b.getAttribute("data-act"); if(!a) return;
    var body={}; try{ body=JSON.parse(b.getAttribute("data-payload")||"{}"); }catch(x){}
    body.action=a; acting=true; busy(true); show("One moment…");
    var x=new XMLHttpRequest(); x.open("POST","/plan/"+ID+"/act?t="+encodeURIComponent(T)); x.setRequestHeader("content-type","application/json");
    x.onload=function(){ var j={}; try{ j=JSON.parse(x.responseText); }catch(err){}
      show(j.toast || (j.ok ? "Done" : "That didn't work.")); setTimeout(function(){ location.reload(); }, j.ok ? 500 : 1500); };
    x.onerror=function(){ show("No connection. Try again."); acting=false; busy(false); setTimeout(hide,2000); };
    x.send(JSON.stringify(body));
  });
  function poll(){
    if(acting) return;
    var x=new XMLHttpRequest(); x.open("GET","/plan/"+ID+"/state?t="+encodeURIComponent(T));
    x.onload=function(){ try{ var j=JSON.parse(x.responseText); if(j && j.rev && j.rev!==REV) location.reload(); }catch(err){} };
    x.send();
  }
  setInterval(poll, 2000);
})();
</script></body></html>`;
}
