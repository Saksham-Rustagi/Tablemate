// Gemini (REST, structured JSON output). Every call: 8 s timeout, 1 retry, daily budget; null on failure => rules-only fallback.
import { config } from "../config";
import { kvGet, kvSet } from "../db";
import { log } from "../events";

const URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const RULES = `You are part of Kin, a gentle helper for ${config.ashaName}, a 78-year-old woman living with memory loss.
Rules you must follow:
- Output ONLY JSON matching the schema.
- Never invent facts. Use only memory ids, names and facts present in the input. If unsure, return null.
- Never write "remember", "do you remember", "recall", or any question that tests her memory. Use statements.
- Short sentences, warm and adult tone, never childish. Plain words.
- Never give medical, legal or financial advice. Never suggest sending money, gift cards or codes.
- Use "person living with memory loss" language; never "sufferer", "senile", "victim".`;

function budgetKey() {
  const pt = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  return `gemini_used_${pt}`;
}
export function geminiUsed(): number {
  return Number(kvGet(budgetKey()) || 0);
}
function spend() {
  kvSet(budgetKey(), String(geminiUsed() + 1));
}
export const geminiDisabled = () => process.env.GEMINI_OFF === "1" || !config.geminiKey || geminiUsed() >= config.geminiDailyLimit * 0.9;

export async function gen<T>(name: string, user: string | any[], schema: object, opts: { timeoutMs?: number; system?: string } = {}): Promise<T | null> {
  if (geminiDisabled()) { log.warn(`gemini ${name}: disabled/out of budget → fallback`); return null; }
  const parts = typeof user === "string" ? [{ text: user }] : user;
  const body = {
    systemInstruction: { parts: [{ text: opts.system ?? RULES }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.3 },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      spend();
      const res = await fetch(`${URL_BASE}/${config.geminiModel}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": config.geminiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
      if (res.status === 429 || res.status === 503) { log.warn(`gemini ${name}: HTTP ${res.status} → fallback`); return null; }
      const j: any = await res.json();
      if (!res.ok) { log.warn(`gemini ${name}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}`); continue; }
      const txt = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      const out = JSON.parse(txt) as T;
      log.info(`gemini ${name}: ok in ${Date.now() - t0} ms`);
      return out;
    } catch (e: any) {
      log.warn(`gemini ${name}: attempt ${attempt + 1} failed (${e?.name === "TimeoutError" ? "timeout" : e?.message ?? e})`);
    }
  }
  return null;
}

// ---------------- schemas (REST OpenAPI subset) ----------------
const S = (type: string, extra: object = {}) => ({ type, ...extra });

export type AssessCompose = {
  isTrivial: boolean; questionForAsha: boolean; isStressful: boolean; needsSummary: boolean;
  mentions: { name: string; kind: string }[];
  scam: { score: number; signals: string[]; claimsToBe: string | null };
  summary: string | null; memory_id: string | null; memory_line: string | null; replies: string[]; calm_note: string | null;
  photo_caption?: string | null;
};
export const assessSchema = S("OBJECT", {
  properties: {
    isTrivial: S("BOOLEAN"), questionForAsha: S("BOOLEAN"), isStressful: S("BOOLEAN"), needsSummary: S("BOOLEAN"),
    mentions: S("ARRAY", { items: S("OBJECT", { properties: { name: S("STRING"), kind: S("STRING", { enum: ["person", "pet", "place", "event", "thing"] }) }, required: ["name", "kind"] }) }),
    scam: S("OBJECT", { properties: { score: S("INTEGER"), signals: S("ARRAY", { items: S("STRING", { enum: ["money", "giftcard", "wire", "crypto", "urgency", "secrecy", "link", "code", "new_number_claim", "impersonation"] }) }), claimsToBe: S("STRING", { nullable: true }) }, required: ["score", "signals"] }),
    summary: S("STRING", { nullable: true }),
    memory_id: S("STRING", { nullable: true }),
    memory_line: S("STRING", { nullable: true }),
    replies: S("ARRAY", { items: S("STRING") }),
    calm_note: S("STRING", { nullable: true }),
    photo_caption: S("STRING", { nullable: true }),
  },
  required: ["isTrivial", "questionForAsha", "isStressful", "needsSummary", "mentions", "scam", "memory_id", "memory_line", "replies"],
});

export type FamilyUnderstanding = {
  intent: "memory" | "reminder" | "urgent" | "alert_safe" | "alert_scam" | "about_me" | "forget" | "other";
  entities: { name: string; kind: string }[];
  edges: { src: string; rel: string; dst: string; label: string }[];
  memories: { about: string; text: string; happened_on: string | null }[];
  reminder: { text: string; due_local: string | null; daily: boolean; in_minutes: number | null } | null;
  confirmation: string;
};
export const familySchema = S("OBJECT", {
  properties: {
    intent: S("STRING", { enum: ["memory", "reminder", "urgent", "alert_safe", "alert_scam", "about_me", "forget", "other"] }),
    entities: S("ARRAY", { items: S("OBJECT", { properties: { name: S("STRING"), kind: S("STRING", { enum: ["person", "pet", "place", "event", "thing"] }) }, required: ["name", "kind"] }) }),
    edges: S("ARRAY", { items: S("OBJECT", { properties: { src: S("STRING"), rel: S("STRING"), dst: S("STRING"), label: S("STRING") }, required: ["src", "rel", "dst", "label"] }) }),
    memories: S("ARRAY", { items: S("OBJECT", { properties: { about: S("STRING"), text: S("STRING"), happened_on: S("STRING", { nullable: true }) }, required: ["about", "text"] }) }),
    reminder: S("OBJECT", { nullable: true, properties: { text: S("STRING"), due_local: S("STRING", { nullable: true }), daily: S("BOOLEAN"), in_minutes: S("INTEGER", { nullable: true }) }, required: ["text", "daily"] }),
    confirmation: S("STRING"),
  },
  required: ["intent", "entities", "edges", "memories", "confirmation"],
});

export type ThreadFacts = { memories: { text: string; happened_on: string | null }[]; entities: { name: string; kind: string }[] };
export const threadSchema = S("OBJECT", {
  properties: {
    memories: S("ARRAY", { items: S("OBJECT", { properties: { text: S("STRING"), happened_on: S("STRING", { nullable: true }) }, required: ["text"] }) }),
    entities: S("ARRAY", { items: S("OBJECT", { properties: { name: S("STRING"), kind: S("STRING", { enum: ["person", "pet", "place", "event", "thing"] }) }, required: ["name", "kind"] }) }),
  },
  required: ["memories", "entities"],
});

export const captionSchema = S("OBJECT", { properties: { caption: S("STRING") }, required: ["caption"] });

export type PhotoMemory = {
  description: string; who_in_photo: string[]; about: string; about_kind: string; memory_text: string;
  happened_on: string | null; use_as_profile: boolean; confirmation: string;
};
export const photoMemorySchema = S("OBJECT", {
  properties: {
    description: S("STRING"),
    who_in_photo: S("ARRAY", { items: S("STRING") }),
    about: S("STRING"),
    about_kind: S("STRING", { enum: ["person", "pet", "place", "event", "thing"] }),
    memory_text: S("STRING"),
    happened_on: S("STRING", { nullable: true }),
    use_as_profile: S("BOOLEAN"),
    confirmation: S("STRING"),
  },
  required: ["description", "who_in_photo", "about", "about_kind", "memory_text", "use_as_profile", "confirmation"],
});

export type VoiceIntent = { transcript: string; intent: "reply" | "question" | "call_me" | "other"; to_person: string | null; text: string };
export const voiceIntentSchema = S("OBJECT", {
  properties: {
    transcript: S("STRING"),
    intent: S("STRING", { enum: ["reply", "question", "call_me", "other"] }),
    to_person: S("STRING", { nullable: true }),
    text: S("STRING"),
  },
  required: ["transcript", "intent", "text"],
});
