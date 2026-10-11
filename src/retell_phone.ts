// GET /retell/phone: the "restaurant phone" for web-call mode (localhost only). The human playing the restaurant host answers
// here; the browser joins the Retell web call with the Retell client SDK. Frutiger Aero styling matches the dashboard.
// ?auto=1 auto-answers the first ringing call (automated tests with Chrome's fake audio capture).

const CSS = `
:root{--ink:#0a3552;--ink2:#2f6487}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:ui-rounded,"SF Pro Rounded",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--ink);display:flex;align-items:center;justify-content:center;background:#7fd3f7;-webkit-font-smoothing:antialiased}
.sky{position:fixed;inset:0;z-index:0;background:linear-gradient(180deg,#36aeee 0%,#79cdf8 20%,#c2ebfd 42%,#f0fbff 52%,#a9e7f3 55.5%,#5fc7df 68%,#2399c1 84%,#0a6893 100%)}
.sun{position:absolute;right:6%;top:-20vh;width:72vh;height:72vh;border-radius:50%;background:radial-gradient(circle,rgba(255,255,236,.95) 0%,rgba(255,250,215,.6) 16%,rgba(255,255,255,.2) 40%,rgba(255,255,255,0) 68%)}
.glass{position:relative;z-index:1;background:linear-gradient(180deg,rgba(255,255,255,.62),rgba(255,255,255,.3));-webkit-backdrop-filter:blur(18px) saturate(1.5);backdrop-filter:blur(18px) saturate(1.5);
  border:1px solid rgba(255,255,255,.82);box-shadow:inset 0 1px 0 rgba(255,255,255,.95),0 20px 44px rgba(4,58,104,.22);border-radius:28px}
.phone{width:min(460px,92vw);height:min(760px,92vh);padding:22px;display:flex;flex-direction:column;gap:14px}
.head{display:flex;align-items:center;gap:12px}
.logo{width:46px;height:46px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:24px;
  background:radial-gradient(circle at 35% 30%,#fff 0 9%,#b9f2ff 22%,#3cc3f1 55%,#0a74bd 100%);box-shadow:inset 0 -7px 12px rgba(255,255,255,.45),0 7px 16px rgba(0,80,140,.35)}
.title{font-size:20px;font-weight:900}.sub{font-size:13px;color:var(--ink2);font-weight:700}
.status{margin-left:auto;font-size:13px;font-weight:800;padding:5px 12px;border-radius:14px;color:var(--ink2);
  background:linear-gradient(180deg,rgba(255,255,255,.96) 0%,rgba(236,244,250,.92) 49%,rgba(213,227,238,.92) 50%,rgba(236,244,250,.96) 100%);box-shadow:inset 0 1px 0 #fff,0 3px 8px rgba(0,60,110,.18)}
.status.live{color:#0b4d1d;background:linear-gradient(180deg,#ecffec 0%,#b8f3bb 49%,#7cdb88 50%,#a7edae 100%)}
.status.ring{color:#5c3d00;background:linear-gradient(180deg,#fff8e6 0%,#ffeab8 49%,#ffd977 50%,#ffe9a8 100%)}
.incoming{padding:18px;border-radius:20px;background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(236,248,255,.82));border:1px solid #fff;box-shadow:0 6px 16px rgba(0,60,110,.12);text-align:center}
.incoming .big{font-size:21px;font-weight:900;line-height:1.3}
.incoming .det{font-size:15px;color:var(--ink2);font-weight:700;margin-top:6px}
.ringing .big{animation:pulse 1.2s ease-in-out infinite}
.empty{padding:40px 10px;text-align:center;color:var(--ink2);font-weight:800;font-size:18px}
.btns{display:flex;gap:12px;justify-content:center}
button{font:inherit;font-weight:900;font-size:20px;border:0;border-radius:40px;padding:16px 28px;color:#fff;cursor:pointer;text-shadow:0 1px 1px rgba(0,0,0,.25);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 8px 18px rgba(0,60,110,.28)}
button:disabled{opacity:.5;cursor:default}
.answer{flex:1;background:linear-gradient(180deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,.1) 50%,rgba(255,255,255,0) 51%),linear-gradient(180deg,#5fdc6c,#178a2c)}
.hang,.decline{background:linear-gradient(180deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,.1) 50%,rgba(255,255,255,0) 51%),linear-gradient(180deg,#ff8f7a,#c9372b)}
.decline{font-size:16px;padding:16px 20px}
.tx{flex:1;min-height:0;overflow-y:auto;padding:4px 2px}
.bub{max-width:88%;padding:8px 12px;border-radius:16px;margin:5px 0;font-size:15.5px;line-height:1.35}
.bub.agent{background:linear-gradient(180deg,#62c0ff,#1f8fe0);color:#fff;margin-left:auto;border-bottom-right-radius:5px}
.bub.user{background:#fff;border:1px solid #d6e9f5;border-bottom-left-radius:5px}
.bub small{display:block;font-size:11px;opacity:.75;font-weight:800}
.err{font-size:13px;color:#c1242c;font-weight:700;min-height:1em}
.hidden{display:none!important}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
`;

const JS = `
const AUTO = new URLSearchParams(location.search).get("auto") === "1";
const $ = (id) => document.getElementById(id);
let state = "idle"; // idle | ringing | connecting | live | ended
let pending = null, client = null, autoDone = false, current = null;

function diag(ev, msg) {
  fetch("/retell/phone/diag", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ev, msg: msg == null ? undefined : String(msg), callId: current }) }).catch(() => {});
}
function setStatus(text, cls) { const s = $("status"); s.textContent = text; s.className = "status" + (cls ? " " + cls : ""); }
function render() {
  $("none").classList.toggle("hidden", !(state === "idle" && !pending));
  $("incoming").classList.toggle("hidden", !pending && state !== "connecting" && state !== "live" && state !== "ended");
  $("incoming").classList.toggle("ringing", state === "ringing");
  $("ringBtns").classList.toggle("hidden", state !== "ringing");
  $("callBtns").classList.toggle("hidden", state !== "connecting" && state !== "live");
  $("tx").classList.toggle("hidden", state === "idle" || state === "ringing");
  if (pending) {
    $("big").textContent = state === "ringing" ? "📞 Incoming call" : state === "ended" ? "Call ended" : "📞 On the line";
    $("det").textContent = "Tablemate is calling " + pending.restaurant + " for " + pending.name + ", party of " + pending.partySize + " at " + pending.time;
  }
  setStatus(state === "ringing" ? "Ringing" : state === "connecting" ? "Connecting…" : state === "live" ? "Live" : state === "ended" ? "Ended" : "No calls",
    state === "ringing" ? "ring" : state === "live" ? "live" : "");
}
function showTranscript(list) {
  const box = $("tx"); box.textContent = "";
  for (const u of list || []) {
    if (!u || !u.content) continue;
    const d = document.createElement("div"); d.className = "bub " + (u.role === "agent" ? "agent" : "user");
    const who = document.createElement("small"); who.textContent = u.role === "agent" ? "Tablemate (AI)" : "Restaurant (you)";
    d.appendChild(who); d.appendChild(document.createTextNode(u.content)); box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}

async function poll() {
  if (state === "idle" || state === "ringing" || state === "ended") {
    try {
      const r = await fetch("/retell/phone/pending", { cache: "no-store" });
      const j = await r.json();
      if (j.call) {
        if (state !== "ringing" || !pending || pending.callId !== j.call.callId) { pending = j.call; state = "ringing"; showTranscript([]); $("err").textContent = ""; render(); }
        if (AUTO && !autoDone) { autoDone = true; answer(); }
      } else if (state === "ringing") { pending = null; state = "idle"; render(); }
    } catch (e) { /* server restarting */ }
  }
  setTimeout(poll, 1000);
}

async function loadSdk() {
  const mod = await import("https://esm.sh/retell-client-js-sdk@3");
  return mod.RetellWebClient;
}

async function answer() {
  if (state !== "ringing" || !pending) return;
  state = "connecting"; render();
  const callId = pending.callId; current = callId;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    diag("getUserMedia ok");
  } catch (e) { diag("getUserMedia error", e && e.message || e); $("err").textContent = "Microphone blocked: " + (e && e.message || e); }
  let RetellWebClient;
  try { RetellWebClient = await loadSdk(); } catch (e) { diag("sdk load error", e && e.message || e); $("err").textContent = "Couldn't load the Retell SDK"; state = "ringing"; render(); return; }
  let tok;
  try {
    const r = await fetch("/retell/phone/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId }) });
    tok = await r.json();
    if (!r.ok || !tok.accessToken) throw new Error(tok.error || ("HTTP " + r.status));
  } catch (e) { diag("answer error", e && e.message || e); $("err").textContent = "Answer failed: " + (e && e.message || e); state = "ringing"; render(); return; }
  current = tok.callId;
  client = new RetellWebClient();
  client.on("call_started", () => { diag("call_started"); state = "live"; render(); });
  client.on("call_ended", () => { diag("call_ended"); state = "ended"; render(); client = null; });
  client.on("update", (u) => { if (u && u.transcript) showTranscript(u.transcript); });
  client.on("error", (e) => { diag("sdk error", e && e.message || e); $("err").textContent = "Call error: " + (e && e.message || e); try { client && client.stopCall(); } catch (_) {} });
  try {
    const cfg = { accessToken: tok.accessToken, callId: tok.callId };
    if (tok.transport) cfg.transport = tok.transport;
    if (tok.iceServers) cfg.iceServers = tok.iceServers;
    await client.startCall(cfg);
    diag("startCall ok");
  } catch (e) { diag("startCall error", e && e.message || e); $("err").textContent = "Couldn't join: " + (e && e.message || e); state = "ended"; render(); }
}

async function decline() {
  if (state !== "ringing" || !pending) return;
  const callId = pending.callId; current = callId;
  await fetch("/retell/phone/decline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId }) }).catch(() => {});
  diag("declined"); pending = null; state = "idle"; render();
}

function hangUp() { diag("hang up"); try { client && client.stopCall(); } catch (e) { diag("stopCall error", e && e.message || e); } state = "ended"; render(); }

$("answer").onclick = answer;
$("decline").onclick = decline;
$("hang").onclick = hangUp;
window.addEventListener("error", (e) => diag("page error", e.message));
window.addEventListener("unhandledrejection", (e) => diag("page error", e.reason && e.reason.message || e.reason));
diag("load", AUTO ? "auto=1" : "");
render(); poll();
`;

export function renderPhonePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Restaurant phone · Tablemate demo</title><style>${CSS}</style></head><body>
<div class="sky"><div class="sun"></div></div>
<div class="glass phone">
  <div class="head"><div class="logo">☎️</div><div><div class="title">Restaurant phone</div><div class="sub">Tablemate demo line</div></div><div id="status" class="status">No calls</div></div>
  <div id="none" class="empty">No calls</div>
  <div id="incoming" class="incoming hidden"><div id="big" class="big">📞 Incoming call</div><div id="det" class="det"></div></div>
  <div id="ringBtns" class="btns hidden"><button id="answer" class="answer">Answer</button><button id="decline" class="decline">Decline</button></div>
  <div id="tx" class="tx hidden"></div>
  <div id="err" class="err"></div>
  <div id="callBtns" class="btns hidden"><button id="hang" class="hang">Hang up</button></div>
</div>
<script type="module">${JS}</script>
</body></html>`;
}
