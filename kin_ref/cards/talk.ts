// "Talk to Kin": an in-card ElevenLabs WebRTC voice chat (no phone line). Mic verified working in the Spectrum webview.
export function renderTalk(o: { cardId: string; token: string; base: string; title: string }): string {
  const ELEVEN = "https://esm.sh/@elevenlabs/client@1.25.0";
  const css = `
:root{color-scheme:light}*{box-sizing:border-box}html,body{height:100%}
body{margin:0;font:clamp(14px,5vmin,22px) -apple-system,"SF Pro Rounded",system-ui,sans-serif;color:#0b2a4a;
background:linear-gradient(180deg,#c9efff 0%,#7fd0ff 45%,#2fa8e0 100%);display:flex;align-items:center;justify-content:center;padding:2vmin;overflow:hidden}
.panel{width:100%;max-width:560px;max-height:100%;background:rgba(255,255,255,.85);border-radius:6vmin;padding:3vmin 4vmin;text-align:center;
box-shadow:0 10px 30px rgba(0,60,120,.25),inset 0 1px 0 #fff;backdrop-filter:blur(8px)}
h1{font-size:clamp(18px,8vmin,40px);margin:.1em 0}
.orb{width:clamp(70px,30vmin,160px);height:clamp(70px,30vmin,160px);margin:2vmin auto;border-radius:50%;border:0;color:#fff;font:700 clamp(14px,5vmin,22px) -apple-system,system-ui;
background:radial-gradient(circle at 35% 30%,#ffffff 0 8%,#8be0ff 18%,#1f8fe0 60%,#0d5fa8 100%);box-shadow:0 8px 24px rgba(0,70,140,.35),inset 0 -6px 12px rgba(0,0,0,.15)}
.orb.live{animation:pulse 1.6s infinite}.orb.speaking{animation-duration:.8s}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(31,143,224,.55)}70%{box-shadow:0 0 0 22px rgba(31,143,224,0)}100%{box-shadow:0 0 0 0 rgba(31,143,224,0)}}
.btn{display:inline-block;min-height:clamp(36px,12vmin,60px);margin:1vmin;padding:0 4vmin;border:0;border-radius:999px;font:700 clamp(14px,5vmin,22px) -apple-system,system-ui;color:#fff;
background:linear-gradient(180deg,#7cc8ff 0%,#1f8fe0 55%,#1678c2 100%);box-shadow:inset 0 2px 0 rgba(255,255,255,.6)}
.red{background:linear-gradient(180deg,#ff9a8a,#d9342b)}#s{min-height:1.3em}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Talk to Kin</title><style>${css}</style></head><body><div class="panel">
<h1>🎙️ Talk to Kin</h1><button class="orb" id="talk">Tap to talk</button><div id="s">Kin will help with ${o.title.replace(/[<>&"]/g, "")}'s message.</div>
<div><button class="btn red" id="end" style="display:none">End</button><button class="btn" id="safari">Open in Safari</button><button class="btn" id="back">Back</button></div>
</div><script type="module">
const id=${JSON.stringify(o.cardId)}, t=${JSON.stringify(o.token)}, base=${JSON.stringify(o.base)};
const s=document.getElementById("s"), talk=document.getElementById("talk"), end=document.getElementById("end");
const diag=(ev,extra={})=>fetch("/diag",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({page:"talk",id,ev,...extra})}).catch(()=>{});
document.getElementById("back").onclick=()=>{location.href="/card/"+id+"?t="+t};
document.getElementById("safari").onclick=()=>{diag("safari");window.open(base+"/talk/"+id+"?t="+t,"_blank")};
let conv=null;
talk.onclick=async()=>{
  if(conv)return; talk.disabled=true; s.textContent="Connecting…";
  try{
    const st=await Promise.race([navigator.mediaDevices.getUserMedia({audio:true}),new Promise((_,rej)=>setTimeout(()=>rej(Object.assign(new Error("The microphone didn't answer"),{name:"MicTimeout"})),7000))]);
    st.getTracks().forEach(x=>x.stop()); diag("mic-ok");
    const {Conversation}=await import(${JSON.stringify(ELEVEN)});
    const body=await (await fetch("/talk/"+id+"/session?t="+t,{method:"POST"})).json();
    if(!body.ok)throw new Error(body.error||"couldn't connect");
    conv=await Conversation.startSession({conversationToken:body.conversationToken,connectionType:"webrtc",dynamicVariables:body.dynamicVariables,
      onConnect:()=>{diag("connected");talk.className="orb live";talk.textContent="Listening";end.style.display="inline-block";s.textContent="You're talking to Kin."},
      onModeChange:({mode})=>{talk.classList.toggle("speaking",mode==="speaking");talk.textContent=mode==="speaking"?"Kin":"Listening"},
      onDisconnect:()=>{diag("disconnect");fetch("/talk/"+id+"/end?t="+t,{method:"POST"}).catch(()=>{});talk.className="orb";talk.textContent="Done";end.style.display="none";s.textContent="Talk ended. Tap Back to see your card."},
      onError:(e)=>{diag("error",{e:String(e?.message??e)});s.textContent="Connection problem. Try Open in Safari."}});
  }catch(err){diag("fail",{name:err?.name,msg:String(err?.message??err)});conv=null;talk.disabled=false;
    s.textContent=(err?.name==="NotAllowedError"?"Kin needs the microphone. ":"Couldn't connect. ")+"Try Open in Safari.";}
};
end.onclick=async()=>{try{await conv?.endSession()}catch{}};
</script></body></html>`;
}
