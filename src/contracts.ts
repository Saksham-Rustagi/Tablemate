// Tablemate module contracts. Three Claude Code sessions build against these in parallel:
//   A = chat + plan + cards + server + dashboard (owns everything not listed for B/C)
//   B = src/places.ts + src/memory.ts
//   C = src/calls.ts + src/retell_sync.ts
// Do NOT change a signature here without updating every implementer. Types only + tiny helpers.

export type Person = { handle: string; name: string; cardCapable: boolean };

export type FactKind = "diet" | "allergy" | "dislike" | "like" | "budget" | "availability";
export type Fact = {
  id: number;
  chatId: string;
  handle: string;
  name: string;
  kind: FactKind;
  value: string; // normalised, lower-case: "vegetarian", "peanuts", "sushi", "cheap", "not after 20:30"
  quote: string; // exact words from the chat message (verified substring)
  msgId: string;
  saidAt: string; // ISO
  source: "chat" | "demo_seed";
};
export type NewFact = Omit<Fact, "id">;

export type PlanQuery = {
  chatId: string;
  meal: "breakfast" | "lunch" | "dinner" | "drinks" | "food";
  day: string; // YYYY-MM-DD, America/New_York
  chosenTime: string; // HH:MM 24h
  windowStart: string; // HH:MM
  windowEnd: string; // HH:MM
  area?: string | null;
  partySize: number;
};

export type PlaceOption = {
  placeId: string;
  name: string;
  address: string;
  phone: string; // E.164 (internationalPhoneNumber normalised)
  mapsUri: string;
  lat: number;
  lng: number;
  priceLevel: number | null; // 0..4 (FREE..VERY_EXPENSIVE)
  rating: number | null;
  ratingCount: number | null;
  walkMin: number;
  primaryType: string;
  cuisineLabel: string; // primaryTypeDisplayName, e.g. "Italian Restaurant"
  emoji: string; // cuisine emoji (no photos on our Places key)
  photo: string | null; // "/media/<file>.jpg" if a photo exists, else null
  reservable: boolean | null;
  why: string; // code-built, references only real facts, ≤ 48 chars, e.g. "Veggie menu · Nicole's vegetarian"
};
export type Skipped = { placeId: string; name: string; reason: string; factId: number }; // reason e.g. "Nicole's vegetarian (Thu)"
export type SearchResult = {
  options: PlaceOption[]; // ≤ 3, best first
  skipped: Skipped | null; // the best place removed by a FACT filter (shown on the card)
  considered: number;
  filteredOut: { name: string; reason: string }[]; // every removal, for the dashboard
};

// ---- B: src/memory.ts
export interface MemoryModule {
  initMemory(): void; // CREATE TABLE IF NOT EXISTS fact(...)
  /** Verifies each fact (quote must be a substring of the given message text, handle must be a member), dedupes on (chatId, handle, kind, value), saves, emits dashboard events. Returns the newly saved facts. */
  saveFacts(chatId: string, facts: NewFact[], messageTextById: Record<string, string>, members: Person[]): Fact[];
  factsFor(chatId: string): Fact[];
  forgetFact(id: number): void;
  allergiesFor(chatId: string, handles: string[]): string[]; // e.g. ["peanuts (Raj)"]
}
// ---- B: src/places.ts
export interface PlacesModule {
  searchPlaces(q: PlanQuery, facts: Fact[]): Promise<SearchResult>;
}

// ---- C: src/calls.ts
export type CallStatus = "booked" | "full" | "offered_other_time" | "no_reservations" | "card_required" | "voicemail" | "no_answer" | "other";
export type CallResult = {
  planId: string;
  attempt: number;
  status: CallStatus;
  time: string | null; // HH:MM 24h
  partySize: number | null;
  name: string | null;
  note: string | null;
  retellCallId: string;
};
export type CallRequest = {
  planId: string;
  attempt: number; // 1..3
  option: PlaceOption;
  partySize: number;
  chosenTime: string; // HH:MM
  windowStart: string; // HH:MM (chosen - 30 min)
  windowEnd: string; // HH:MM (chosen + 30 min)
  bookingName: string;
  callbackNumber: string; // organizer's E.164, or "" if not shareable
  allergies: string[];
};
export interface CallsModule {
  initCalls(): void; // CREATE TABLE IF NOT EXISTS call(...)
  /** Enforces: REAL_CALLS / DEMO_RESTAURANT_PHONE redirect, max 3 attempts per plan, never the same place twice per plan, open-hours check is the caller's job. */
  /** RETELL_MODE=web (no phone number yet): records a ringing call answered at /retell/phone; dialed = "web". */
  placeCall(req: CallRequest): Promise<{ ok: boolean; callId?: string; error?: string; dialed?: "demo" | "real" | "web" }>;
  /** Handles POST /retell/tool/report_result and POST /retell/webhook (signature-verified). Returns null for other paths. */
  retellRoutes(req: Request, url: URL): Promise<Response | null>;
  /** plan.ts registers this; calls.ts invokes it exactly once per (planId, attempt). */
  setCallResultHandler(fn: (r: CallResult) => void | Promise<void>): void;
  ensureRetellSynced(baseUrl: string): Promise<void>;
}

// Dashboard events (src/events.ts emit()) that B and C may emit, A renders:
//   { kind: "fact", fact: Fact }                       (B)
//   { kind: "filter", planId, name, reason }           (B, via searchPlaces callers — A emits these from SearchResult.filteredOut)
//   { kind: "call", planId, attempt, phase: "dialing"|"started"|"ended"|"result", detail: string }   (C)
//   { kind: "transcript", planId, attempt, role: "agent"|"restaurant", text: string }                (C, from transcript_updated)
