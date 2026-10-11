// Calls: place the Retell booking call, take the report_result tool + webhooks, hand each (plan, attempt) result to plan.ts exactly once.
import Retell from "retell-sdk";
import { db, kvGet, nowIso } from "./db";
import { emit, log } from "./events";
import type { CallRequest, CallResult, CallStatus, CallsModule } from "./contracts";
import { ensureRetellSynced, retellApi } from "./retell_sync";

export { ensureRetellSynced };

const MAX_ATTEMPTS = 3;
const STATUSES: CallStatus[] = ["booked", "full", "offered_other_time", "no_reservations", "card_required", "voicemail", "no_answer", "other"];

type CallRow = {
  id: string; plan_id: string; attempt: number; place_id: string; place_name: string; retell_call_id: string | null;
  to_number: string; dialed: "demo" | "real"; status: string; result_json: string | null; transcript: string | null;
  started_at: string | null; ended_at: string | null;
};

export function initCalls(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS call (id TEXT PRIMARY KEY, plan_id TEXT, attempt INT, place_id TEXT, place_name TEXT,
    retell_call_id TEXT UNIQUE, to_number TEXT, dialed TEXT, status TEXT, result_json TEXT, transcript TEXT, started_at TEXT, ended_at TEXT)`);
}

let resultHandler: ((r: CallResult) => void | Promise<void>) | null = null;
export function setCallResultHandler(fn: (r: CallResult) => void | Promise<void>): void {
  resultHandler = fn;
}

const callEvent = (planId: string, attempt: number, phase: "dialing" | "started" | "ended" | "result", detail: string) =>
  emit({ kind: "call", planId, attempt, phase, detail } as any);

const rowByRetellId = (id: string) => (db.query("SELECT * FROM call WHERE retell_call_id = ?").get(id) as CallRow | null) ?? null;
const rowByAttempt = (planId: string, attempt: number) =>
  (db.query("SELECT * FROM call WHERE plan_id = ? AND attempt = ?").get(planId, attempt) as CallRow | null) ?? null;
const latestAttempt = (planId: string) => (db.query("SELECT MAX(attempt) AS a FROM call WHERE plan_id = ?").get(planId) as { a: number | null }).a;

// ---------- formatting ----------
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const normTime = (t: unknown): string | null => {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(t ?? ""));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
};
const normStatus = (s: unknown): CallStatus => (STATUSES.includes(String(s) as CallStatus) ? (String(s) as CallStatus) : "other");
const strOrNull = (s: unknown) => { const v = typeof s === "string" ? s.trim() : ""; return v ? v : null; };
const numOrNull = (n: unknown) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? Math.round(v) : null; };
const maskNum = (n: string) => (n ? "…" + n.slice(-4) : "?");

// ---------- placing a call ----------
export async function placeCall(req: CallRequest): Promise<{ ok: boolean; callId?: string; error?: string; dialed?: "demo" | "real" }> {
  const { planId, attempt, option } = req;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) return { ok: false, error: `attempt must be 1..${MAX_ATTEMPTS}` };
  const existing = db.query("SELECT attempt, place_id FROM call WHERE plan_id = ?").all(planId) as { attempt: number; place_id: string }[];
  if (existing.length >= MAX_ATTEMPTS) return { ok: false, error: `max ${MAX_ATTEMPTS} calls per plan reached` };
  if (existing.some((r) => r.attempt === attempt)) return { ok: false, error: `attempt ${attempt} already placed for this plan` };
  if (existing.some((r) => r.place_id === option.placeId)) return { ok: false, error: `${option.name} was already called for this plan` };

  // Rule 8: every call goes to the demo phone unless REAL_CALLS=1 AND the place is allowlisted.
  const allow = (process.env.REAL_CALL_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  const real = process.env.REAL_CALLS === "1" && allow.includes(option.placeId) && !!option.phone;
  const to = real ? option.phone : (process.env.DEMO_RESTAURANT_PHONE || "").trim();
  if (!to) return { ok: false, error: "DEMO_RESTAURANT_PHONE is not set; refusing to call" };
  const from = kvGet("retell_from_number") || process.env.RETELL_FROM_NUMBER || "";
  if (!from) return { ok: false, error: "no Retell from-number (run sync with RETELL_BUY_NUMBER=1)" };
  const agentId = kvGet("retell_agent_id");
  const dialed: "demo" | "real" = real ? "real" : "demo";

  const id = `${planId}-${attempt}`;
  db.query("INSERT INTO call (id, plan_id, attempt, place_id, place_name, to_number, dialed, status) VALUES (?,?,?,?,?,?,?, 'dialing')")
    .run(id, planId, attempt, option.placeId, option.name, to, dialed);

  const allergies = req.allergies.filter(Boolean).join(", ");
  const vars: Record<string, string> = {
    restaurant_name: option.name,
    party_size: String(req.partySize),
    time_12h: to12h(req.chosenTime),
    day_label: toMin(req.chosenTime) >= 17 * 60 ? "tonight" : "today",
    window_start_12h: to12h(req.windowStart),
    window_end_12h: to12h(req.windowEnd),
    booking_name: req.bookingName,
    callback_number: req.callbackNumber || "none",
    allergies: allergies || "none",
    plan_id: planId,
    attempt: String(attempt),
  };
  const body = {
    from_number: from,
    to_number: to,
    metadata: { plan_id: planId, attempt },
    retell_llm_dynamic_variables: vars,
    idempotency_key: `${planId}-${attempt}`,
    ...(agentId ? { override_agent_id: agentId, override_agent_version: "latest" } : {}),
  };
  const label = real ? `📞 Real call: ${option.name} (${maskNum(to)})` : `📞 Demo call: ${option.name} → demo phone (${maskNum(to)})`;
  callEvent(planId, attempt, "dialing", label);
  log.info(`${label} [plan ${planId} attempt ${attempt}]`);
  try {
    const r = await retellApi("POST", "/v2/create-phone-call", body);
    const callId = r.json?.call_id as string | undefined;
    if (r.status < 200 || r.status >= 300 || !callId) throw new Error(`create-phone-call ${r.status}: ${String(r.json?.message ?? r.json?.error_message ?? "").slice(0, 160)}`);
    db.query("UPDATE call SET retell_call_id = ?, status = 'registered' WHERE id = ?").run(callId, id);
    return { ok: true, callId, dialed };
  } catch (e) {
    // Nothing was dialled: free the attempt slot so the caller can retry or move on.
    db.query("DELETE FROM call WHERE id = ?").run(id);
    log.error(`Retell call failed for ${option.name}`, e);
    callEvent(planId, attempt, "ended", `Call failed: ${(e as Error).message}`);
    return { ok: false, error: (e as Error).message, dialed };
  }
}

// ---------- result delivery (exactly once per plan+attempt) ----------
function deliver(stale: CallRow, r: Omit<CallResult, "planId" | "attempt" | "retellCallId">, via: string): boolean {
  const row = rowByAttempt(stale.plan_id, stale.attempt) ?? stale;
  const result: CallResult = { planId: row.plan_id, attempt: row.attempt, retellCallId: row.retell_call_id || "", ...r };
  const changed = db.query("UPDATE call SET result_json = ? WHERE id = ? AND result_json IS NULL").run(JSON.stringify(result), row.id).changes;
  if (changed !== 1) return false;
  callEvent(row.plan_id, row.attempt, "result", `${row.place_name}: ${result.status}${result.time ? ` ${result.time}` : ""}${result.note ? ` — ${result.note}` : ""} (via ${via})`);
  log.info(`Call result ${row.plan_id}#${row.attempt} ${row.place_name}: ${result.status} (via ${via})`);
  if (!resultHandler) { log.warn("No call result handler registered"); return true; }
  Promise.resolve()
    .then(() => resultHandler!(result))
    .catch((e) => log.error("Call result handler failed", e));
  return true;
}

const hasResult = (id: string) => !!(db.query("SELECT result_json FROM call WHERE id = ?").get(id) as { result_json: string | null } | null)?.result_json;

function fromDisconnection(reason: string | undefined): CallStatus {
  if (reason === "voicemail_reached") return "voicemail";
  return "no_answer"; // dial_no_answer, dial_busy, dial_failed, user_declined, inactivity, … → move on
}

function fromAnalysis(call: any): Omit<CallResult, "planId" | "attempt" | "retellCallId"> | null {
  const a = call?.call_analysis;
  if (!a) return null;
  const d = a.custom_analysis_data ?? {};
  const outcome = String(d.outcome ?? "");
  if (STATUSES.includes(outcome as CallStatus)) {
    return { status: outcome as CallStatus, time: normTime(d.booked_time), partySize: numOrNull(d.party_size), name: null, note: strOrNull(a.call_summary)?.slice(0, 200) ?? null };
  }
  if (a.in_voicemail) return { status: "voicemail", time: null, partySize: null, name: null, note: null };
  return { status: fromDisconnection(call?.disconnection_reason), time: null, partySize: null, name: null, note: call?.disconnection_reason ?? null };
}

// ---------- signature ----------
async function verified(req: Request): Promise<{ raw: string; ok: boolean }> {
  const raw = await req.text();
  const sig = req.headers.get("x-retell-signature") || "";
  const key = process.env.RETELL_API_KEY || "";
  if (!sig || !key) return { raw, ok: false };
  try { return { raw, ok: await Retell.verify(raw, key, sig) }; } catch { return { raw, ok: false }; }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------- tool: report_result ----------
async function onReportResult(req: Request): Promise<Response> {
  const { raw, ok } = await verified(req);
  if (!ok) return json({ error: "bad signature" }, 401);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const args = body?.args ?? body ?? {};
  const planId = String(args.plan_id ?? "");
  const attempt = Number(args.attempt);
  const meta = body?.call?.metadata;
  if (meta && (String(meta.plan_id) !== planId || Number(meta.attempt) !== attempt)) return json({ result: "Unknown call." }, 403);
  const row = planId && Number.isInteger(attempt) ? rowByAttempt(planId, attempt) : null;
  if (!row || latestAttempt(planId) !== attempt) return json({ result: "Unknown call." }, 403);
  const callId = body?.call?.call_id;
  if (callId && row.retell_call_id && callId !== row.retell_call_id) return json({ result: "Unknown call." }, 403);
  if (callId && !row.retell_call_id) db.query("UPDATE call SET retell_call_id = ? WHERE id = ?").run(callId, row.id);
  deliver(row,{ status: normStatus(args.status), time: normTime(args.time), partySize: numOrNull(args.party_size), name: strOrNull(args.name), note: strOrNull(args.note) }, "tool");
  return json({ result: "Thanks, noted." });
}

// ---------- webhooks ----------
const emittedUtterances = new Map<string, number>();

function emitTranscript(row: CallRow, utterances: { role: string; content: string }[], final: boolean) {
  const key = row.retell_call_id || row.id;
  const done = emittedUtterances.get(key) ?? 0;
  // The last utterance may still be growing until the call ends; emit it only once it's final.
  const upto = final ? utterances.length : utterances.length - 1;
  for (let i = done; i < upto; i++) {
    const u = utterances[i];
    if (!u?.content?.trim()) continue;
    emit({ kind: "transcript", planId: row.plan_id, attempt: row.attempt, role: u.role === "agent" ? "agent" : "restaurant", text: u.content.trim() } as any);
  }
  if (upto > done) emittedUtterances.set(key, upto);
}

const analysisWaitMs = () => Number(process.env.RETELL_ANALYSIS_WAIT_MS || 20000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function processWebhook(body: any): Promise<void> {
  const event = String(body?.event ?? "");
  const call = body?.call ?? {};
  let row = call.call_id ? rowByRetellId(call.call_id) : null;
  if (!row && call.metadata?.plan_id) {
    row = rowByAttempt(String(call.metadata.plan_id), Number(call.metadata.attempt));
    if (row && row.retell_call_id && row.retell_call_id !== call.call_id) row = null;
    if (row && !row.retell_call_id && call.call_id) db.query("UPDATE call SET retell_call_id = ? WHERE id = ?").run(call.call_id, row.id);
  }
  if (!row) { log.warn(`Retell webhook ${event} for unknown call`); return; }

  if (event === "call_started") {
    const changed = db.query("UPDATE call SET status = 'started', started_at = ? WHERE id = ? AND status IN ('dialing','registered')").run(nowIso(), row.id).changes;
    if (changed) callEvent(row.plan_id, row.attempt, "started", `${row.place_name} picked up`);
  } else if (event === "transcript_updated") {
    emitTranscript(row, Array.isArray(call.transcript_object) ? call.transcript_object : [], false);
  } else if (event === "call_ended") {
    emitTranscript(row, Array.isArray(call.transcript_object) ? call.transcript_object : [], true);
    const changed = db.query("UPDATE call SET status = 'ended', ended_at = ?, transcript = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status != 'ended'")
      .run(nowIso(), typeof call.transcript === "string" ? call.transcript : null, nowIso(), row.id).changes;
    if (!changed) return; // retry of an ended webhook
    callEvent(row.plan_id, row.attempt, "ended", `${row.place_name}: call ended (${call.disconnection_reason ?? "unknown"})`);
    if (hasResult(row.id)) return;
    const quick = call.call_analysis ? fromAnalysis(call) : null;
    if (!quick) {
      const until = Date.now() + analysisWaitMs();
      while (Date.now() < until) {
        if (hasResult(row.id)) return;
        await sleep(Math.min(500, analysisWaitMs()));
      }
      if (hasResult(row.id)) return;
    }
    deliver(row, quick ?? { status: fromDisconnection(call.disconnection_reason), time: null, partySize: null, name: null, note: call.disconnection_reason ?? null }, quick ? "analysis" : "call_ended");
  } else if (event === "call_analyzed") {
    if (typeof call.transcript === "string") db.query("UPDATE call SET transcript = COALESCE(transcript, ?) WHERE id = ?").run(call.transcript, row.id);
    const r = fromAnalysis(call);
    if (r) deliver(row, r, "analysis");
  }
}

async function onWebhook(req: Request): Promise<Response> {
  const { raw, ok } = await verified(req);
  if (!ok) return new Response("bad signature", { status: 401 });
  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  // Respond at once (10 s timeout, retries); do the work after.
  setTimeout(() => { processWebhook(body).catch((e) => log.error("Retell webhook processing failed", e)); }, 0);
  return new Response(null, { status: 204 });
}

export async function retellRoutes(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "POST") return null;
  if (url.pathname === "/retell/tool/report_result") return onReportResult(req);
  if (url.pathname === "/retell/webhook") return onWebhook(req);
  return null;
}

export const calls: CallsModule = { initCalls, placeCall, retellRoutes, setCallResultHandler, ensureRetellSynced };
