// ONE real Retell test call: kv from-number → PROBE_TO, demo dynamic vars. Polls /v2/get-call until ended,
// then prints the transcript and the stored report_result row (the running server receives the tool callback).
// Run by the orchestrator only:  PROBE_TO=+1… ~/.bun/bin/bun scripts/retell_probe.ts
import { db, kvGet } from "../src/db";
import { initCalls } from "../src/calls";
import { retellApi } from "../src/retell_sync";

const to = process.env.PROBE_TO || "";
const from = kvGet("retell_from_number") || process.env.RETELL_FROM_NUMBER || "";
const agentId = kvGet("retell_agent_id");
if (!to || !from || !agentId) {
  console.log(`missing: ${[!to && "PROBE_TO", !from && "from number (kv retell_from_number)", !agentId && "agent (run sync_retell)"].filter(Boolean).join(", ")}`);
  process.exit(1);
}
initCalls();
const planId = `probe_${Date.now().toString(36)}`;
const attempt = 1;
// A call row so the report_result tool callback is accepted by the server (it checks plan_id/attempt).
db.query("INSERT INTO call (id, plan_id, attempt, place_id, place_name, to_number, dialed, status) VALUES (?,?,?,?,?,?, 'demo', 'dialing')")
  .run(`${planId}-${attempt}`, planId, attempt, "probe_place", "Probe Bistro", to);

const vars = {
  restaurant_name: "Probe Bistro", party_size: "4", time_12h: "7:30 PM", day_label: "tonight",
  window_start_12h: "7:00 PM", window_end_12h: "8:00 PM", booking_name: "Nicole", callback_number: "none",
  allergies: "peanuts", plan_id: planId, attempt: String(attempt),
};
const r = await retellApi("POST", "/v2/create-phone-call", {
  from_number: from, to_number: to, metadata: { plan_id: planId, attempt }, retell_llm_dynamic_variables: vars,
  idempotency_key: `${planId}-${attempt}`, override_agent_id: agentId, override_agent_version: "latest",
});
console.log(`create-phone-call → ${r.status}`);
const callId = r.json?.call_id as string | undefined;
if (!callId) { console.log(JSON.stringify(r.json).slice(0, 300)); process.exit(1); }
db.query("UPDATE call SET retell_call_id = ?, status = 'registered' WHERE plan_id = ? AND attempt = ?").run(callId, planId, attempt);
console.log(`call id: ${callId}  plan: ${planId}`);

let call: any = null;
let last = "";
for (let i = 0; i < 120; i++) {
  await new Promise((res) => setTimeout(res, 3000));
  const g = await retellApi("GET", `/v2/get-call/${callId}`);
  call = g.json;
  const s = `${g.status} ${call?.call_status ?? "?"}`;
  if (s !== last) { console.log(`status: ${s}`); last = s; }
  if (call?.call_status === "ended" || call?.call_status === "error") break;
}
console.log(`disconnection: ${call?.disconnection_reason ?? "-"}`);
console.log("--- transcript ---");
console.log(call?.transcript ?? "(none)");
await new Promise((res) => setTimeout(res, 2000));
console.log("--- stored row ---");
console.log(JSON.stringify(db.query("SELECT * FROM call WHERE plan_id = ?").get(planId), null, 2));
