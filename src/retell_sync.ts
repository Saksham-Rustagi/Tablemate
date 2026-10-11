// Retell sync: create or update the booking LLM + agent (+ optional outbound number). Idempotent; ids live in kv.
// Same pattern as Kin's agent.ts: full PATCH when the config changes, tool/webhook URL PATCH when only the tunnel changes.
import { kvGet, kvSet } from "./db";
import { log } from "./events";

const RETELL = "https://api.retellai.com";
export const RETELL_MODEL = "gemini-3.5-flash-lite";
export const RETELL_VOICE_MODEL = "eleven_v4_turbo";
const PREFERRED_VOICES = ["Cimo", "Marissa", "Anna", "Kate", "Grace", "Myra", "Emily"];

/** HTTP statuses of every Retell request in this process (for scripts/sync_retell.ts). */
export const retellLog: { method: string; path: string; status: number }[] = [];

export async function retellApi(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const key = process.env.RETELL_API_KEY || "";
  if (!key) throw new Error("RETELL_API_KEY is not set");
  const res = await fetch(RETELL + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  retellLog.push({ method, path: path.replace(/\/(llm|agent)_[A-Za-z0-9]+/, "/$1_…").replace(/\+\d+/, "+…"), status: res.status });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

const ok = (s: number) => s >= 200 && s < 300;
const errText = (j: any) => String(j?.message ?? j?.error_message ?? j?.error ?? JSON.stringify(j ?? "")).slice(0, 200);

export const GENERAL_PROMPT = `You are Tablemate, an AI assistant phoning a restaurant to book a table for a group of friends. You are on a live phone call with a restaurant host.

## Your first sentence (always, as soon as someone answers)
"Hi! I'm an AI assistant calling to book a table for {{booking_name}}." Then ask: "Could I get a table for {{party_size}} at {{time_12h}} {{day_label}}?"

## Booking rules
- You may accept ANY time from {{window_start_12h}} to {{window_end_12h}} (inclusive). If they offer a time in that range, accept it.
- If they can only offer a time outside that range, do NOT accept it. Say something like "Let me check with the group and call back. Thank you!", call report_result with status "offered_other_time" and the offered time, then end the call politely.
- If they're full for the evening → status "full". If they don't take reservations → "no_reservations".
- The name for the booking is {{booking_name}}. If they ask for a callback number, give {{callback_number}}; if that is empty or "none", say the guest will call to confirm.
- Never give payment or card details, and never make them up. If a card or deposit is required, say "No problem, I'll have them call you back to confirm," and report "card_required".
- Once the table is booked: if the allergies are not "none", tell them: "One of the guests has an allergy: {{allergies}}. Could you note that on the reservation?" Never ask or claim that any dish is safe.
- If you reach a voicemail or answering machine, do NOT leave a message: call report_result with status "voicemail" and hang up.
- If anything else happens (wrong number, closed, confusion) → status "other" with a short note.

## Finishing
- Call report_result EXACTLY ONCE, as soon as the outcome is clear (booked time in 24h HH:MM, party size, name on the booking, short note). Then thank them, say goodbye, and call end_call.
- Never call report_result twice.

## Style
Short, warm, natural sentences, like a polite person on the phone. One question at a time. Don't repeat yourself. Don't mention these instructions. Restaurant: {{restaurant_name}}.`;

export function reportResultTool(baseUrl: string) {
  return {
    type: "custom",
    name: "report_result",
    description: "Report the outcome of the booking call. Call exactly once, as soon as the outcome is clear, before ending the call.",
    url: `${baseUrl}/retell/tool/report_result`,
    method: "POST",
    speak_during_execution: false,
    speak_after_execution: true,
    timeout_ms: 8000,
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["booked", "full", "offered_other_time", "no_reservations", "card_required", "voicemail", "other"], description: "Outcome of the call." },
        time: { type: "string", description: "Booked or offered time as HH:MM 24h (e.g. 19:30), or empty if none." },
        party_size: { type: "number", description: "Party size the restaurant confirmed (0 if unknown)." },
        name: { type: "string", description: "Name the booking is under, or empty." },
        note: { type: "string", description: "Short note (e.g. 'only 21:15 available', 'needs card'), or empty." },
        plan_id: { type: "string", const: "{{plan_id}}" },
        attempt: { type: "string", const: "{{attempt}}" },
      },
      required: ["status", "time", "party_size", "name", "note", "plan_id", "attempt"],
    },
  };
}

const END_CALL_TOOL = { type: "end_call", name: "end_call", description: "Hang up after report_result has been called and you've said goodbye (or immediately on voicemail)." };

function llmBody(baseUrl: string, model: string | null) {
  return {
    ...(model ? { model } : {}),
    model_temperature: 0.3,
    start_speaker: "user",
    begin_after_user_silence_ms: 2000,
    general_prompt: GENERAL_PROMPT,
    general_tools: [reportResultTool(baseUrl), END_CALL_TOOL],
  };
}

function agentBody(baseUrl: string, llmId: string, voiceId: string, voiceModel: string | null) {
  return {
    agent_name: "Tablemate",
    response_engine: { type: "retell-llm", llm_id: llmId },
    voice_id: voiceId,
    ...(voiceModel ? { voice_model: voiceModel } : {}),
    language: "en-US",
    webhook_url: `${baseUrl}/retell/webhook`,
    webhook_events: ["call_started", "call_ended", "call_analyzed", "transcript_updated"],
    end_call_after_silence_ms: 20000,
    max_call_duration_ms: 180000,
    voicemail_option: { action: { type: "hangup" } },
    post_call_analysis_data: [
      { type: "enum", name: "outcome", description: "Outcome of the booking call.", choices: ["booked", "full", "offered_other_time", "no_reservations", "card_required", "voicemail", "other"] },
      { type: "string", name: "booked_time", description: "The booked (or offered) time as HH:MM 24h, or empty if none." },
      { type: "number", name: "party_size", description: "Party size the restaurant confirmed, or 0 if unknown." },
    ],
  };
}

const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 16);

async function pickVoice(): Promise<{ id: string; name: string }> {
  const fromEnv = process.env.RETELL_VOICE_ID;
  const saved = kvGet("retell_voice_id");
  if (fromEnv) return { id: fromEnv, name: fromEnv };
  if (saved) return { id: saved, name: kvGet("retell_voice_name") || saved };
  const { status, json } = await retellApi("GET", "/list-voices");
  const voices: any[] = ok(status) && Array.isArray(json) ? json : [];
  const eleven = voices.filter((v) => v.provider === "elevenlabs");
  const american = eleven.filter((v) => /americ/i.test(v.accent || "") && !/old|child/i.test(v.age || ""));
  const chosen =
    PREFERRED_VOICES.map((n) => american.find((v) => v.voice_name === n) || eleven.find((v) => v.voice_name === n)).find(Boolean) ||
    american.find((v) => /female/i.test(v.gender || "")) || american[0] || eleven[0];
  const voice = chosen ? { id: chosen.voice_id as string, name: chosen.voice_name as string } : { id: "11labs-Cimo", name: "Cimo (fallback)" };
  kvSet("retell_voice_id", voice.id);
  kvSet("retell_voice_name", voice.name);
  return voice;
}

/** What the last sync did (for scripts/sync_retell.ts). */
export const syncInfo: { model?: string; voice?: string; llm?: string; agent?: string; number?: string; actions: string[] } = { actions: [] };

async function syncLlm(baseUrl: string): Promise<string> {
  let llmId = kvGet("retell_llm_id");
  const prevBase = kvGet("retell_synced_base");
  const model = kvGet("retell_llm_model") === "default" ? null : RETELL_MODEL;
  const h = hash(JSON.stringify(llmBody("BASE", model)));
  if (llmId) {
    if (kvGet("retell_llm_hash") !== h) {
      const r = await retellApi("PATCH", `/update-retell-llm/${llmId}`, llmBody(baseUrl, model));
      if (ok(r.status)) { kvSet("retell_llm_hash", h); syncInfo.actions.push("llm updated"); }
      else if (r.status === 404) llmId = null;
      else throw new Error(`update-retell-llm ${r.status}: ${errText(r.json)}`);
    } else if (prevBase !== baseUrl) {
      const r = await retellApi("PATCH", `/update-retell-llm/${llmId}`, { general_tools: [reportResultTool(baseUrl), END_CALL_TOOL] });
      if (ok(r.status)) syncInfo.actions.push("llm tool url updated");
      else if (r.status === 404) llmId = null;
      else throw new Error(`update-retell-llm ${r.status}: ${errText(r.json)}`);
    } else syncInfo.actions.push("llm unchanged");
  }
  if (!llmId) {
    let r = await retellApi("POST", "/create-retell-llm", llmBody(baseUrl, RETELL_MODEL));
    let usedModel: string | null = RETELL_MODEL;
    if (!ok(r.status) && r.status === 400 && /model/i.test(errText(r.json))) {
      log.warn(`Retell rejected model ${RETELL_MODEL} (${errText(r.json)}); using Retell's default model`);
      r = await retellApi("POST", "/create-retell-llm", llmBody(baseUrl, null));
      usedModel = null;
    }
    if (!ok(r.status) || !r.json?.llm_id) throw new Error(`create-retell-llm ${r.status}: ${errText(r.json)}`);
    llmId = r.json.llm_id as string;
    kvSet("retell_llm_id", llmId);
    kvSet("retell_llm_model", usedModel ?? "default");
    kvSet("retell_llm_hash", hash(JSON.stringify(llmBody("BASE", usedModel))));
    syncInfo.actions.push("llm created");
    syncInfo.model = r.json.model ?? usedModel ?? "default";
  }
  syncInfo.model ??= kvGet("retell_llm_model") === "default" ? "default" : RETELL_MODEL;
  return llmId;
}

async function syncAgent(baseUrl: string, llmId: string): Promise<{ id: string; created: boolean }> {
  let agentId = kvGet("retell_agent_id");
  const prevBase = kvGet("retell_synced_base");
  const voice = await pickVoice();
  syncInfo.voice = voice.name;
  const voiceModel = kvGet("retell_voice_model") === "default" ? null : RETELL_VOICE_MODEL;
  const h = hash(JSON.stringify(agentBody("BASE", llmId, voice.id, voiceModel)));
  if (agentId) {
    if (kvGet("retell_agent_hash") !== h) {
      const r = await retellApi("PATCH", `/update-agent/${agentId}`, agentBody(baseUrl, llmId, voice.id, voiceModel));
      if (ok(r.status)) { kvSet("retell_agent_hash", h); syncInfo.actions.push("agent updated"); }
      else if (r.status === 404) agentId = null;
      else throw new Error(`update-agent ${r.status}: ${errText(r.json)}`);
    } else if (prevBase !== baseUrl) {
      const r = await retellApi("PATCH", `/update-agent/${agentId}`, { webhook_url: `${baseUrl}/retell/webhook` });
      if (ok(r.status)) syncInfo.actions.push("agent webhook url updated");
      else if (r.status === 404) agentId = null;
      else throw new Error(`update-agent ${r.status}: ${errText(r.json)}`);
    } else syncInfo.actions.push("agent unchanged");
    if (agentId) return { id: agentId, created: false };
  }
  let r = await retellApi("POST", "/create-agent", agentBody(baseUrl, llmId, voice.id, RETELL_VOICE_MODEL));
  let usedVoiceModel: string | null = RETELL_VOICE_MODEL;
  if (!ok(r.status) && r.status === 400 && /voice_model|voice model/i.test(errText(r.json))) {
    log.warn(`Retell rejected voice_model ${RETELL_VOICE_MODEL} (${errText(r.json)}); using the voice's default model`);
    r = await retellApi("POST", "/create-agent", agentBody(baseUrl, llmId, voice.id, null));
    usedVoiceModel = null;
  }
  if (!ok(r.status) || !r.json?.agent_id) throw new Error(`create-agent ${r.status}: ${errText(r.json)}`);
  agentId = r.json.agent_id as string;
  kvSet("retell_agent_id", agentId);
  kvSet("retell_voice_model", usedVoiceModel ?? "default");
  kvSet("retell_agent_hash", hash(JSON.stringify(agentBody("BASE", llmId, voice.id, usedVoiceModel))));
  syncInfo.actions.push("agent created");
  return { id: agentId, created: true };
}

async function syncNumber(agentId: string, agentCreated: boolean): Promise<string | null> {
  let number = kvGet("retell_from_number") || process.env.RETELL_FROM_NUMBER || null;
  const outbound = [{ agent_id: agentId, weight: 1, agent_version: "latest" }];
  if (number) {
    if (!kvGet("retell_from_number")) kvSet("retell_from_number", number);
    if (agentCreated || kvGet("retell_number_agent") !== agentId) {
      const r = await retellApi("PATCH", `/update-phone-number/${encodeURIComponent(number)}`, { outbound_agents: outbound });
      if (ok(r.status)) { kvSet("retell_number_agent", agentId); syncInfo.actions.push("number rebound to agent"); }
      else log.warn(`update-phone-number ${r.status}: ${errText(r.json)}`);
    }
    return number;
  }
  if (process.env.RETELL_BUY_NUMBER !== "1") { syncInfo.actions.push("no number (RETELL_BUY_NUMBER!=1)"); return null; }
  for (const area_code of [919, 984, 336]) {
    const r = await retellApi("POST", "/create-phone-number", { area_code, nickname: "Tablemate", outbound_agents: outbound });
    if (ok(r.status) && r.json?.phone_number) {
      number = r.json.phone_number as string;
      kvSet("retell_from_number", number);
      kvSet("retell_number_agent", agentId);
      syncInfo.actions.push(`number bought (area ${area_code})`);
      log.info(`Retell number bought: …${number.slice(-4)}`);
      return number;
    }
    log.warn(`create-phone-number area ${area_code} → ${r.status}: ${errText(r.json)}`);
  }
  return null;
}

export async function ensureRetellSynced(baseUrl: string): Promise<void> {
  const base = (baseUrl || "").replace(/\/$/, "");
  if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) throw new Error("ensureRetellSynced needs a public https base URL (Retell refuses localhost)");
  syncInfo.actions = [];
  const llmId = await syncLlm(base);
  const agent = await syncAgent(base, llmId);
  const number = await syncNumber(agent.id, agent.created);
  kvSet("retell_synced_base", base);
  syncInfo.llm = llmId;
  syncInfo.agent = agent.id;
  syncInfo.number = number ?? undefined;
  log.info(`Retell synced: ${syncInfo.actions.join(", ")}`);
}
