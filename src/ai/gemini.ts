// Gemini (REST, structured JSON output). Every call: 8 s timeout, 1 retry, daily budget; null on failure => regex fallback.
import { config } from "../config";
import { kvGet, kvSet } from "../db";
import { log } from "../events";

const URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const RULES = `You read a friends' group chat for Tablemate, an assistant that helps the group book a table.
Rules you must follow:
- Output ONLY JSON matching the schema.
- Never invent facts. Every fact quote must be the exact words from one message, copied character for character.
- Only use handles that appear in the input.
- If unsure, leave a list empty or a field null. Plain code decides every action; you only extract.`;

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
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
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
export const S = (type: string, extra: object = {}) => ({ type, ...extra });

export type GroupTurn = {
  intent: {
    is_plan: boolean; confidence: number; meal: "breakfast" | "lunch" | "dinner" | "drinks" | "food" | null;
    day: string | null; time_window: { start: string | null; end: string | null } | null;
    area_hint: string | null; organizer_handle: string | null;
  };
  facts: { handle: string; kind: "diet" | "allergy" | "dislike" | "like" | "budget" | "availability"; value: string; quote: string; msg_index: number }[];
  text_votes: { handle: string; option_number: number }[];
  rsvps: { handle: string; status: "in" | "out"; time_pref: string | null }[];
};

export const groupTurnSchema = S("OBJECT", {
  properties: {
    intent: S("OBJECT", {
      properties: {
        is_plan: S("BOOLEAN"),
        confidence: S("NUMBER"),
        meal: S("STRING", { nullable: true, enum: ["breakfast", "lunch", "dinner", "drinks", "food"] }),
        day: S("STRING", { nullable: true, description: "YYYY-MM-DD in America/New_York" }),
        time_window: S("OBJECT", { nullable: true, properties: { start: S("STRING", { nullable: true, description: "HH:MM 24h" }), end: S("STRING", { nullable: true, description: "HH:MM 24h" }) } }),
        area_hint: S("STRING", { nullable: true }),
        organizer_handle: S("STRING", { nullable: true }),
      },
      required: ["is_plan", "confidence", "meal", "day", "organizer_handle"],
    }),
    facts: S("ARRAY", {
      items: S("OBJECT", {
        properties: {
          handle: S("STRING"),
          kind: S("STRING", { enum: ["diet", "allergy", "dislike", "like", "budget", "availability"] }),
          value: S("STRING", { description: "short, lower-case: vegetarian, peanuts, sushi, cheap, not after 20:30" }),
          quote: S("STRING", { description: "exact words copied from the message" }),
          msg_index: S("INTEGER", { description: "index of the NEW message the quote comes from" }),
        },
        required: ["handle", "kind", "value", "quote", "msg_index"],
      }),
    }),
    text_votes: S("ARRAY", { items: S("OBJECT", { properties: { handle: S("STRING"), option_number: S("INTEGER") }, required: ["handle", "option_number"] }) }),
    rsvps: S("ARRAY", {
      items: S("OBJECT", {
        properties: { handle: S("STRING"), status: S("STRING", { enum: ["in", "out"] }), time_pref: S("STRING", { nullable: true, description: "HH:MM 24h" }) },
        required: ["handle", "status"],
      }),
    }),
  },
  required: ["intent", "facts", "text_votes", "rsvps"],
});
