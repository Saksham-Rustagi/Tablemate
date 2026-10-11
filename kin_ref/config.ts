// Kin configuration: everything comes from ~/kin/.env (Bun loads it automatically when run from ~/kin).
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

export const config = {
  projectId: env.SPECTRUM_PROJECT_ID || env.PROJECT_ID || "",
  projectSecret: env.SPECTRUM_PROJECT_SECRET || env.PROJECT_SECRET || "",
  /** Asha's handle that Kin's cloud line can reach (must be a phone number on the Pro shared pool). */
  ashaHandle: normalizeHandle(env.GRANDMA_HANDLE),
  /** Other handles that belong to Asha (e.g. her iCloud email) — recognised on inbound. */
  ashaAliases: list(env.GRANDMA_ALIASES).map(normalizeHandle),
  /** Caregiver's phone (Priya). */
  caregiverHandle: normalizeHandle(env.CAREGIVER_HANDLE || env.PRIYA_HANDLE),
  kinLines: new Set(list(env.KIN_LINE_HANDLES).map(normalizeHandle)),
  /** Testing safety net: only these senders are ever processed from the local (Asha's Mac) stream. Empty = nobody; "*" = everyone. */
  allowSenders: list(env.TEST_SENDERS).map(normalizeHandle),
  publicBase: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  signingSecret: env.KIN_SIGNING_SECRET || "dev-secret",
  geminiKey: env.GEMINI_API_KEY || "",
  geminiModel: env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  geminiDailyLimit: Number(env.GEMINI_DAILY_LIMIT || 500),
  elevenKey: env.ELEVENLABS_API_KEY || "",
  elevenAgent: env.ELEVENLABS_AGENT_ID || "",
  elevenVoice: env.ELEVENLABS_VOICE_ID || "",
  elevenToolSecret: env.ELEVENLABS_TOOL_SECRET || "",
  cardMode: (env.CARD_MODE || "app") as "app" | "text",
  tz: env.TZ || "America/New_York",
  quietHours: env.QUIET_HOURS || "21:00-08:00",
  quietHoursEnabled: env.QUIET_HOURS_ENABLED === "1",
  /** Demo clock: reminder escalation minutes become seconds. */
  fastClock: env.DEMO_FAST_CLOCK === "1",
  debounceMs: Number(env.DEBOUNCE_MS || 4000),
  port: Number(env.PORT || 3000),
  dataDir: env.KIN_DATA_DIR || "data",
  ashaName: env.ASHA_NAME || "Asha",
  ashaCalledBy: env.ASHA_CALLED_BY || "Nani", // what family calls her in alerts: "Mom"/"Nani"
  /** Process local messages that arrived while Kin was down (resume from the saved chat.db ROWID). */
  resumeLocal: env.KIN_RESUME_LOCAL !== "0",
};

/** Fails closed: an empty TEST_SENDERS lets nobody through. TEST_SENDERS=* opts out of the allowlist explicitly. */
export function isAllowedLocalSender(h: string): boolean {
  if (!config.allowSenders.length) return false;
  if (config.allowSenders.includes("*")) return true;
  const n = normalizeHandle(h);
  return config.allowSenders.includes(n);
}

export function isKinLine(h: string): boolean {
  return config.kinLines.has(normalizeHandle(h));
}

export function isAsha(h: string): boolean {
  const n = normalizeHandle(h);
  return n === config.ashaHandle || config.ashaAliases.includes(n);
}

/** Scale a duration in minutes for the demo clock (default: 1 minute → 2 s, so the T+30 nudge comes after 60 s). */
export function minutes(n: number): number {
  return config.fastClock ? n * Number(process.env.DEMO_MINUTE_MS || 2000) : n * 60_000;
}

export function mask(h: string): string {
  if (!h) return "?";
  if (h.includes("@")) return h[0] + "…@" + h.split("@")[1];
  return "…" + h.slice(-4);
}

export function fmtTime(d: Date | string | number = new Date()): string {
  return new Date(d).toLocaleTimeString("en-US", { timeZone: config.tz, hour: "numeric", minute: "2-digit" });
}
