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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
