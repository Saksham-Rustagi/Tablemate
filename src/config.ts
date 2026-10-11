// Tablemate configuration: everything comes from ~/tablemate/.env (Bun loads it automatically when run from ~/tablemate).
import type { Person } from "./contracts";

const env = process.env;

const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Normalize a handle: phones to E.164 (default region US), emails lowercased. */
export function normalizeHandle(h: string | undefined | null): string {
  if (!h) return "";
  const s = h.trim();
  if (s.includes("@")) return s.toLowerCase();
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d ? "+" + d : s;
}

export const isPhone = (h: string) => /^\+\d{8,15}$/.test(h);

/** TM_PEOPLE = "Saksham:+19195550101,Nicole:+19195550102,Maya:maya@icloud.com". Card-capable = phone handle. */
function parsePeople(v?: string): Person[] {
  const out: Person[] = [];
  for (const item of list(v)) {
    const i = item.indexOf(":");
    if (i < 1) continue;
    const handle = normalizeHandle(item.slice(i + 1));
    if (!handle) continue;
    out.push({ name: item.slice(0, i).trim(), handle, cardCapable: isPhone(handle) });
  }
  return out;
}

export const config = {
  projectId: env.SPECTRUM_PROJECT_ID || env.PHOTON_PROJECT_ID || env.PROJECT_ID || "",
  projectSecret: env.SPECTRUM_PROJECT_SECRET || env.PHOTON_PROJECT_SECRET || env.PROJECT_SECRET || "",
  port: Number(env.PORT || 3001),
  dataDir: env.TM_DATA_DIR || "data",
  dbPath: env.TM_DB || "data/tablemate.db",
  groupChatIds: list(env.TM_GROUP_CHAT_IDS),
  people: parsePeople(env.TM_PEOPLE),
  /** Tablemate's own cloud line numbers: their messages also land in chat.db (echo) and are dropped. */
  lineHandles: new Set(list(env.TM_LINE_HANDLES).map(normalizeHandle)),
  publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  cardSecret: env.CARD_HMAC_SECRET || "dev-secret",
  /** Plan deadline: 2 min in the demo, 45 min for real. The deadline only closes voting; it never books. */
  demoFast: env.DEMO_FAST === "1",
  campusLat: Number(env.CAMPUS_LAT || 35.9121),
  campusLng: Number(env.CAMPUS_LNG || -79.0512),
  geminiKey: env.TM_GEMINI_API_KEY || env.GEMINI_API_KEY || "",
  geminiModel: env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  geminiDailyLimit: Number(env.GEMINI_DAILY_LIMIT || 500),
  tz: "America/New_York",
  debounceMs: Number(env.TM_DEBOUNCE_MS ?? 8000),
};

export function members(): Person[] {
  return config.people;
}
export function memberByHandle(h: string | null | undefined): Person | null {
  const n = normalizeHandle(h);
  return config.people.find((p) => p.handle === n) ?? null;
}

/** Chat ids from chat.db look like "iMessage;+;chat123…" or "any;+;chat123…"; match on the full id or the chat GUID part. */
export function isEnrolledChat(id: string | null | undefined): boolean {
  if (!id) return false;
  const tail = (s: string) => s.split(";").pop() || s;
  return config.groupChatIds.some((g) => g === id || tail(g) === tail(id));
}

export function isTablemateLine(h: string): boolean {
  return config.lineHandles.has(normalizeHandle(h));
}

export function planDeadlineMs(): number {
  return (config.demoFast ? 2 : 45) * 60_000;
}

export function mask(h: string): string {
  if (!h) return "?";
  if (h.includes("@")) return h[0] + "…@" + h.split("@")[1];
  return "…" + h.slice(-4);
}

export function fmtTime(d: Date | string | number = new Date()): string {
  return new Date(d).toLocaleTimeString("en-US", { timeZone: config.tz, hour: "numeric", minute: "2-digit" });
}

/** "19:30" → "7:30 PM". */
export function fmt12(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
