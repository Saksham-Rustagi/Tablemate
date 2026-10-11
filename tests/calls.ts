// Calls module tests (no network: Retell fetch is mocked). Run: ~/.bun/bin/bun tests/calls.ts
import { rmSync } from "fs";

process.env.TM_DB = process.env.KIN_DB = "data/calls_test.db";
for (const f of ["", "-wal", "-shm"]) rmSync(`data/calls_test.db${f}`, { force: true });
process.env.RETELL_API_KEY = "key_test_123";
process.env.RETELL_FROM_NUMBER = "+19195550100";
process.env.DEMO_RESTAURANT_PHONE = "+19195550199";
process.env.REAL_CALLS = "0";
process.env.REAL_CALL_ALLOWLIST = "";
process.env.RETELL_ANALYSIS_WAIT_MS = "300";

const Retell = (await import("retell-sdk")).default;
const { kvSet } = await import("../src/db");
const { subscribe } = await import("../src/events");
const calls = await import("../src/calls");
import type { CallRequest, CallResult, PlaceOption } from "../src/contracts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- mock Retell
const sent: { url: string; body: any }[] = [];
let nextId = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(init.body) : null;
  sent.push({ url, body });
  if (url.endsWith("/v2/create-phone-call")) return new Response(JSON.stringify({ call_id: `rc_${++nextId}`, call_status: "registered" }), { status: 201 });
  return new Response("{}", { status: 404 });
}) as any;

// ---- events + handler
const events: any[] = [];
subscribe((e: any) => events.push(e));
const results: CallResult[] = [];
calls.initCalls();
calls.setCallResultHandler((r) => { results.push(r); });
kvSet("retell_agent_id", "agent_test");

const opt = (id: string, phone = "+19195551234"): PlaceOption => ({
  placeId: id, name: `Place ${id}`, address: "1 Franklin St", phone, mapsUri: "", lat: 0, lng: 0, priceLevel: 2, rating: 4.5,
  ratingCount: 100, walkMin: 5, primaryType: "restaurant", cuisineLabel: "Restaurant", emoji: "🍽️", photo: null, reservable: true, why: "",
});
const reqFor = (planId: string, attempt: number, option: PlaceOption): CallRequest => ({
  planId, attempt, option, partySize: 4, chosenTime: "19:30", windowStart: "19:00", windowEnd: "20:00",
  bookingName: "Nicole", callbackNumber: "", allergies: ["peanuts (Raj)"],
});

async function post(path: string, body: unknown, sign = true): Promise<Response> {
  const raw = JSON.stringify(body);
  const sig = sign ? await Retell.sign(raw, process.env.RETELL_API_KEY!) : "v=1,d=" + "0".repeat(64);
  const req = new Request(`https://x.test${path}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-retell-signature": sig } });
  return (await calls.retellRoutes(req, new URL(req.url)))!;
}
const lastCallBody = () => [...sent].reverse().find((s) => s.url.endsWith("/v2/create-phone-call"))!.body;

// 1. REAL_CALLS=0 always dials the demo phone
let r = await calls.placeCall(reqFor("p1", 1, opt("A")));
check("REAL_CALLS=0 dials demo", r.ok && r.dialed === "demo" && lastCallBody().to_number === "+19195550199", JSON.stringify(r));
const b = lastCallBody();
check("dynamic vars are strings + idempotency key", Object.values(b.retell_llm_dynamic_variables).every((v) => typeof v === "string")
  && b.retell_llm_dynamic_variables.time_12h === "7:30 PM" && b.retell_llm_dynamic_variables.day_label === "tonight"
  && b.retell_llm_dynamic_variables.window_start_12h === "7:00 PM" && b.retell_llm_dynamic_variables.allergies === "peanuts (Raj)"
  && b.retell_llm_dynamic_variables.callback_number === "none"
  && b.idempotency_key === "p1-1" && b.metadata.plan_id === "p1" && b.metadata.attempt === 1, JSON.stringify(b));
check("dialing event emitted", events.some((e) => e.kind === "call" && e.phase === "dialing" && e.planId === "p1" && /Demo call/.test(e.detail)));

// 2. REAL_CALLS=1 without allowlist still dials demo; with allowlist dials the real number
process.env.REAL_CALLS = "1";
r = await calls.placeCall(reqFor("p2", 1, opt("B")));
check("REAL_CALLS=1 without allowlist dials demo", r.ok && r.dialed === "demo" && lastCallBody().to_number === "+19195550199");
process.env.REAL_CALL_ALLOWLIST = "C";
r = await calls.placeCall(reqFor("p2", 2, opt("C", "+19195557777")));
check("REAL_CALLS=1 + allowlisted dials real", r.ok && r.dialed === "real" && lastCallBody().to_number === "+19195557777");
process.env.REAL_CALLS = "0";
r = await calls.placeCall(reqFor("p2", 3, opt("D", "+19195558888")));
check("REAL_CALLS=0 ignores allowlist", r.ok && r.dialed === "demo" && lastCallBody().to_number === "+19195550199");
process.env.REAL_CALL_ALLOWLIST = "";

// 3. 4th attempt refused, same place twice refused, empty demo phone refused
r = await calls.placeCall(reqFor("p2", 4, opt("E")));
check("4th attempt refused", !r.ok);
const before = sent.length;
r = await calls.placeCall(reqFor("p1", 2, opt("A")));
check("same place twice refused", !r.ok && /already called/.test(r.error || "") && sent.length === before, JSON.stringify(r));
process.env.DEMO_RESTAURANT_PHONE = "";
r = await calls.placeCall(reqFor("p3", 1, opt("F")));
check("empty DEMO_RESTAURANT_PHONE refused", !r.ok && sent.length === before);
process.env.DEMO_RESTAURANT_PHONE = "+19195550199";

// 4. signature checks
let res = await post("/retell/webhook", { event: "call_started", call: { call_id: "rc_1" } }, false);
check("webhook bad signature → 401", res.status === 401);
res = await post("/retell/tool/report_result", { name: "report_result", args: { status: "booked", plan_id: "p1", attempt: "1" } }, false);
check("tool bad signature → 401", res.status === 401);
check("no result after bad signatures", results.length === 0);

// 5. tool with wrong plan_id rejected
res = await post("/retell/tool/report_result", { call: { call_id: "rc_1", metadata: { plan_id: "nope", attempt: 1 } }, name: "report_result", args: { status: "booked", time: "19:30", party_size: 4, name: "Nicole", note: "", plan_id: "nope", attempt: "1" } });
check("tool wrong plan_id rejected", res.status === 403 && results.length === 0);
res = await post("/retell/tool/report_result", { call: { call_id: "rc_1", metadata: { plan_id: "p1", attempt: 1 } }, name: "report_result", args: { status: "booked", time: "19:30", party_size: 4, name: "Nicole", note: "", plan_id: "p1", attempt: "2" } });
check("tool wrong attempt rejected", res.status === 403 && results.length === 0);

// 6. started + transcript events (once per utterance, across retries)
res = await post("/retell/webhook", { event: "call_started", call: { call_id: "rc_1", metadata: { plan_id: "p1", attempt: 1 } } });
check("webhook → 204", res.status === 204);
const t1 = [{ role: "user", content: "Sitar, how can I help?" }, { role: "agent", content: "Hi! I'm an AI assistant" }];
const t2 = [...t1.slice(0, 1), { role: "agent", content: "Hi! I'm an AI assistant calling to book a table for Nicole." }, { role: "user", content: "Sure, 7:30 works." }];
await post("/retell/webhook", { event: "transcript_updated", call: { call_id: "rc_1", transcript_object: t1 } });
await post("/retell/webhook", { event: "transcript_updated", call: { call_id: "rc_1", transcript_object: t1 } }); // retry
await post("/retell/webhook", { event: "transcript_updated", call: { call_id: "rc_1", transcript_object: t2 } });
await sleep(30);
let tr = events.filter((e) => e.kind === "transcript" && e.planId === "p1");
check("transcript: finalized utterances only, no dupes", tr.length === 2 && tr[0].role === "restaurant" && tr[1].role === "agent" && /for Nicole/.test(tr[1].text), JSON.stringify(tr));
check("started event once", events.filter((e) => e.kind === "call" && e.phase === "started" && e.planId === "p1").length === 1);

// 7. tool result → handler once; tool retry + call_ended + call_analyzed don't re-invoke
const toolBody = { call: { call_id: "rc_1", metadata: { plan_id: "p1", attempt: 1 } }, name: "report_result", args: { status: "booked", time: "19:30", party_size: 4, name: "Nicole", note: "", plan_id: "p1", attempt: "1" } };
res = await post("/retell/tool/report_result", toolBody);
const jr = await res.json();
check("tool accepted with JSON reply", res.status === 200 && jr.result === "Thanks, noted.");
await post("/retell/tool/report_result", toolBody); // retry
const ended = { event: "call_ended", call: { call_id: "rc_1", disconnection_reason: "agent_hangup", transcript: "…", transcript_object: t2 } };
await post("/retell/webhook", ended);
await post("/retell/webhook", ended); // retry
await post("/retell/webhook", { event: "call_analyzed", call: { call_id: "rc_1", call_analysis: { custom_analysis_data: { outcome: "full" } } } });
await sleep(450);
const p1 = results.filter((x) => x.planId === "p1" && x.attempt === 1);
check("handler invoked exactly once (tool+webhooks+retries)", p1.length === 1 && p1[0].status === "booked" && p1[0].time === "19:30" && p1[0].partySize === 4 && p1[0].retellCallId === "rc_1", JSON.stringify(results));
tr = events.filter((e) => e.kind === "transcript" && e.planId === "p1");
check("transcript final utterance emitted once at call_ended", tr.length === 3 && tr[2].text === "Sure, 7:30 works.", JSON.stringify(tr));
check("ended event once", events.filter((e) => e.kind === "call" && e.phase === "ended" && e.planId === "p1").length === 1);

// 8. no tool: call_ended waits, call_analyzed provides the backup result (once)
await post("/retell/webhook", { event: "call_ended", call: { call_id: "rc_2", disconnection_reason: "user_hangup" } });
await sleep(50);
await post("/retell/webhook", { event: "call_analyzed", call: { call_id: "rc_2", call_analysis: { custom_analysis_data: { outcome: "full", booked_time: "", party_size: 0 } } } });
await post("/retell/webhook", { event: "call_analyzed", call: { call_id: "rc_2", call_analysis: { custom_analysis_data: { outcome: "full" } } } });
await sleep(450);
const p2a = results.filter((x) => x.planId === "p2" && x.attempt === 1);
check("analysis backup result once", p2a.length === 1 && p2a[0].status === "full", JSON.stringify(p2a));

// 9. no tool, no analysis: dial_no_answer → no_answer after the wait; voicemail mapped
await post("/retell/webhook", { event: "call_ended", call: { call_id: "rc_3", disconnection_reason: "dial_no_answer" } });
await post("/retell/webhook", { event: "call_ended", call: { call_id: "rc_4", disconnection_reason: "voicemail_reached" } });
await sleep(500);
const p2b = results.filter((x) => x.planId === "p2" && x.attempt === 2);
const p2c = results.filter((x) => x.planId === "p2" && x.attempt === 3);
check("dial_no_answer → no_answer", p2b.length === 1 && p2b[0].status === "no_answer", JSON.stringify(p2b));
check("voicemail_reached → voicemail", p2c.length === 1 && p2c[0].status === "voicemail", JSON.stringify(p2c));

// 10. create-call failure frees the slot
globalThis.fetch = (async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 })) as any;
r = await calls.placeCall(reqFor("p4", 1, opt("G")));
check("Retell error → not ok", !r.ok);
globalThis.fetch = (async () => new Response(JSON.stringify({ call_id: "rc_99" }), { status: 201 })) as any;
r = await calls.placeCall(reqFor("p4", 1, opt("G")));
check("failed attempt can be retried", r.ok && r.callId === "rc_99");

// ---------- web mode (no phone number: the restaurant answers at /retell/phone) ----------
process.env.RETELL_MODE = "web";
process.env.TM_RING_TIMEOUT_MS = "60000";
const web: { url: string; body: any }[] = [];
let webFail = false;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  web.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  if (webFail) return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
  if (url.endsWith("/v3/create-web-call")) return new Response(JSON.stringify({ call_id: `wc_${web.length}`, access_token: `tok_${web.length}`, transport: "gateway", ice_servers: [], expires_at: Date.now() + 60_000 }), { status: 201 });
  return new Response("{}", { status: 404 });
}) as any;

async function phone(path: string, body?: unknown, host = "localhost:3001", extra: Record<string, string> = {}): Promise<Response> {
  const req = new Request(`http://${host}${path}`, {
    method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { host, "content-type": "application/json", ...extra },
  });
  return (await calls.retellRoutes(req, new URL(req.url)))!;
}
const webResults = (planId: string) => results.filter((x) => x.planId === planId);

// 11. placeCall in web mode → ringing, no Retell request yet
r = await calls.placeCall(reqFor("w1", 1, opt("H")));
check("web placeCall → ok, dialed web, no Retell request", r.ok && r.dialed === "web" && r.callId === "w1-1" && web.length === 0, JSON.stringify(r));
check("web dialing event", events.some((e) => e.kind === "call" && e.phase === "dialing" && e.planId === "w1" && e.detail === "Calling Place H (demo line)…"));
let pj = await (await phone("/retell/phone/pending")).json();
check("pending shows the ringing call", pj.call?.callId === "w1-1" && pj.call.restaurant === "Place H" && pj.call.name === "Nicole" && pj.call.partySize === 4 && pj.call.time === "7:30 PM", JSON.stringify(pj));
const page = await phone("/retell/phone");
const pageHtml = await page.text();
check("phone page served on localhost", page.status === 200 && /Restaurant phone/.test(pageHtml) && /retell-client-js-sdk/.test(pageHtml) && /RetellWebClient/.test(pageHtml));

// 12. non-localhost → 403 on every /retell/phone* route
const blocked = [
  await phone("/retell/phone", undefined, "abc.trycloudflare.com"),
  await phone("/retell/phone/pending", undefined, "abc.trycloudflare.com"),
  await phone("/retell/phone/answer", { callId: "w1-1" }, "abc.trycloudflare.com"),
  await phone("/retell/phone/decline", { callId: "w1-1" }, "evil.test"),
  await phone("/retell/phone/diag", { ev: "x" }, "evil.test"),
  await phone("/retell/phone/pending", undefined, "localhost:3001", { "cf-connecting-ip": "1.2.3.4" }),
];
check("non-localhost /retell/phone* → 403", blocked.every((x) => x.status === 403) && web.length === 0 && webResults("w1").length === 0, blocked.map((x) => x.status).join(","));
check("127.0.0.1 allowed", (await phone("/retell/phone/pending", undefined, "127.0.0.1:3001")).status === 200);

// 13. answer → exactly one create-web-call with metadata + all-string dynamic vars
let res2 = await phone("/retell/phone/answer", { callId: "w1-1" });
const ans = await res2.json();
check("answer returns accessToken", res2.status === 200 && ans.accessToken === "tok_1" && ans.callId === "wc_1" && ans.transport === "gateway", JSON.stringify(ans));
res2 = await phone("/retell/phone/answer", { callId: "w1-1" });
const cw = web.filter((s) => s.url.endsWith("/v3/create-web-call"));
const wb = cw[0]?.body;
check("second answer → 409, one create-web-call total", res2.status === 409 && cw.length === 1 && web.length === 1);
check("create-web-call body: agent, metadata, all vars strings", wb?.agent_id === "agent_test" && wb.metadata.plan_id === "w1" && wb.metadata.attempt === 1
  && Object.keys(wb.retell_llm_dynamic_variables).length === 11 && Object.values(wb.retell_llm_dynamic_variables).every((v) => typeof v === "string")
  && wb.retell_llm_dynamic_variables.restaurant_name === "Place H" && wb.retell_llm_dynamic_variables.attempt === "1"
  && wb.retell_llm_dynamic_variables.plan_id === "w1" && wb.retell_llm_dynamic_variables.time_12h === "7:30 PM", JSON.stringify(wb));
check("started event on answer", events.filter((e) => e.kind === "call" && e.phase === "started" && e.planId === "w1").length === 1);
pj = await (await phone("/retell/phone/pending")).json();
check("answered call no longer pending", pj.call === null);
check("decline after answer → 409", (await phone("/retell/phone/decline", { callId: "w1-1" })).status === 409);

// 14. web_call webhooks + tool map by retell_call_id; exactly once
await post("/retell/webhook", { event: "call_started", call: { call_id: "wc_1", call_type: "web_call", metadata: { plan_id: "w1", attempt: 1 } } });
const wTool = { call: { call_id: "wc_1", call_type: "web_call", metadata: { plan_id: "w1", attempt: 1 } }, name: "report_result", args: { status: "booked", time: "19:45", party_size: 4, name: "Nicole", note: "", plan_id: "w1", attempt: "1" } };
res = await post("/retell/tool/report_result", wTool);
check("web call tool accepted", res.status === 200);
await post("/retell/tool/report_result", wTool);
await post("/retell/webhook", { event: "call_ended", call: { call_id: "wc_1", call_type: "web_call", disconnection_reason: "user_hangup", transcript_object: [] } });
await post("/retell/webhook", { event: "call_analyzed", call: { call_id: "wc_1", call_type: "web_call", call_analysis: { custom_analysis_data: { outcome: "full" } } } });
await sleep(450);
const w1 = webResults("w1");
check("web call result once, via retell_call_id", w1.length === 1 && w1[0].status === "booked" && w1[0].time === "19:45" && w1[0].retellCallId === "wc_1", JSON.stringify(w1));
check("web call started event not duplicated by webhook", events.filter((e) => e.kind === "call" && e.phase === "started" && e.planId === "w1").length === 1);

// 15. decline → no_answer exactly once (the ring timeout later doesn't re-deliver)
process.env.TM_RING_TIMEOUT_MS = "200";
r = await calls.placeCall(reqFor("w2", 1, opt("I")));
res2 = await phone("/retell/phone/decline", { callId: "w2-1" });
const res3 = await phone("/retell/phone/decline", { callId: "w2-1" });
await sleep(350);
const w2 = webResults("w2");
check("decline → no_answer once", r.ok && res2.status === 200 && res3.status === 409 && w2.length === 1 && w2[0].status === "no_answer", JSON.stringify(w2));
check("declined: no Retell request", web.length === 1);

// 16. ring timeout → no_answer exactly once; answering afterwards fails without a Retell request
process.env.TM_RING_TIMEOUT_MS = "150";
r = await calls.placeCall(reqFor("w3", 1, opt("J")));
await sleep(350);
res2 = await phone("/retell/phone/answer", { callId: "w3-1" });
const w3 = webResults("w3");
check("ring timeout → no_answer once", r.ok && w3.length === 1 && w3[0].status === "no_answer" && res2.status === 409 && web.length === 1, JSON.stringify(w3));
check("timed-out call not pending", (await (await phone("/retell/phone/pending")).json()).call === null);
process.env.TM_RING_TIMEOUT_MS = "60000";

// 17. answer failure → 502, still ringing (can retry)
r = await calls.placeCall(reqFor("w5", 1, opt("M")));
webFail = true;
res2 = await phone("/retell/phone/answer", { callId: "w5-1" });
webFail = false;
pj = await (await phone("/retell/phone/pending")).json();
check("create-web-call failure → 502, still ringing", res2.status === 502 && pj.call?.callId === "w5-1" && webResults("w5").length === 0, JSON.stringify(pj));
res2 = await phone("/retell/phone/answer", { callId: "w5-1" });
check("answer retry succeeds", res2.status === 200 && !!(await res2.json()).accessToken);

// 18. 3-attempt cap + same place in web mode
const cap = [];
for (const [a, id] of [[1, "K1"], [2, "K2"], [3, "K3"]] as const) cap.push(await calls.placeCall(reqFor("w4", a, opt(id))));
const fourth = await calls.placeCall(reqFor("w4", 4, opt("K4")));
const again = await calls.placeCall(reqFor("w6", 1, opt("N")));
const samePlace = await calls.placeCall(reqFor("w6", 2, opt("N")));
check("web mode: 3 calls ok, 4th refused", cap.every((x) => x.ok && x.dialed === "web") && !fourth.ok, JSON.stringify(fourth));
check("web mode: same place twice refused", again.ok && !samePlace.ok && /already called/.test(samePlace.error || ""));
delete process.env.RETELL_MODE;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
