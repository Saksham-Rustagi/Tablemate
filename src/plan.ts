// Plan state machine (spec §8). Plain code decides every transition; every transition is a plan_event row + a dashboard event.
//   idle → offered → voting → booking → calling[i] → booked | asking_group | handed_back | cancelled
// Hard rules enforced here: only the organizer's ✅ card tap starts a call (rule 1); ≤ 3 calls, never the same place
// twice (rule 2); a time outside chosen ±30 min goes back to the group (rule 4). The deadline never books.
import type { CallRequest, CallResult, Fact, PlaceOption, PlanQuery, SearchResult } from "./contracts";
import { config, fmt12, isPhone, memberByHandle, members, planDeadlineMs } from "./config";
import { db, nowIso, newId } from "./db";
import { decision, emit, log } from "./events";
import * as places from "./places";
import * as calls from "./calls";
import * as memory from "./memory";
import { editCards, getTransport, planToken, sendCard } from "./cards/service";

export const STATES = ["idle", "offered", "voting", "booking", "calling", "asking_group", "booked", "handed_back", "cancelled"] as const;
export type PlanState = (typeof STATES)[number];
const ACTIVE: PlanState[] = ["offered", "voting", "booking", "calling", "asking_group"];
export const MAX_CALLS = 3;
const OFFER_TTL_MS = 30 * 60_000;

export type PlanRow = {
  id: string; chat_id: string; organizer: string; state: PlanState; meal: string; day: string;
  window_start: string; window_end: string; chosen_time: string; default_time: string; area: string | null;
  created_at: string; deadline_at: string | null; voting_closed: number;
  booked_place_id: string | null; booked_time: string | null; booked_party: number | null; booking_name: string | null;
  attempt: number; tried: string; call_idx: number | null; ask_time: string | null; ask_votes: string;
  status_line: string | null; filtered: string; rev: number;
};

// ---------- dependency injection (tests swap in fakes; nothing else does) ----------
type Deps = {
  searchPlaces: (q: PlanQuery, facts: Fact[]) => Promise<SearchResult>;
  placeCall: (req: CallRequest) => Promise<{ ok: boolean; callId?: string; error?: string; dialed?: "demo" | "real" | "web" }>;
  /** Open-hours re-check at the chosen time. Places already filtered at search time; default trusts that. */
  isOpen: (o: PlaceOption, day: string, time: string) => boolean;
};
let deps: Deps = {
  searchPlaces: (q, f) => places.searchPlaces(q, f),
  placeCall: (r) => calls.placeCall(r),
  isOpen: () => true,
};
export function setDeps(d: Partial<Deps>) { deps = { ...deps, ...d }; }

// ---------- time helpers ----------
export const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const fromMin = (n: number) => { const x = ((n % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
const validHHMM = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export function todayNY(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: config.tz });
}
function dayLabel(day: string, meal: string): string {
  const t = todayNY();
  if (day === t) return meal === "dinner" || meal === "drinks" ? "tonight" : "today";
  if (day === todayNY(new Date(Date.now() + 86_400_000))) return "tomorrow";
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}
const DEFAULT_WINDOWS: Record<string, [string, string]> = {
  breakfast: ["08:30", "10:30"], lunch: ["11:30", "13:30"], dinner: ["18:30", "20:30"], drinks: ["20:00", "22:00"],
};
/** Spec §10: "tonight" with no time → 18:30–20:30; chosen = window start + 1 h, rounded to :00/:30. */
export function planWindow(meal: string, start: string | null | undefined, end: string | null | undefined) {
  const def = DEFAULT_WINDOWS[meal] ?? DEFAULT_WINDOWS.dinner;
  const ws = validHHMM(start) ? start : validHHMM(end) ? fromMin(toMin(end) - 120) : def[0];
  const we = validHHMM(end) && toMin(end) > toMin(ws) ? end : fromMin(toMin(ws) + 120);
  let chosen = Math.round((toMin(ws) + 60) / 30) * 30;
  if (chosen > toMin(we)) chosen = Math.round(toMin(ws) / 30) * 30;
  return { windowStart: ws, windowEnd: we, chosen: fromMin(chosen) };
}
export function chips(p: PlanRow): string[] {
  const d = toMin(p.default_time);
  return [fromMin(d - 30), p.default_time, fromMin(d + 30)];
}

// ---------- reads ----------
export function getPlan(id: string): PlanRow | null {
  return (db.query("SELECT * FROM plan WHERE id = ?").get(id) as PlanRow | null) ?? null;
}
export function latestPlan(chatId?: string): PlanRow | null {
  const q = chatId ? db.query("SELECT * FROM plan WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1").get(chatId) : db.query("SELECT * FROM plan ORDER BY created_at DESC LIMIT 1").get();
  return (q as PlanRow | null) ?? null;
}
export function activePlan(chatId: string): PlanRow | null {
  const p = db.query(`SELECT * FROM plan WHERE chat_id = ? AND state IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 1`).get(chatId, ...ACTIVE) as PlanRow | null;
  if (p && p.state === "offered" && Date.now() - Date.parse(p.created_at) > OFFER_TTL_MS) { transition(p, "idle", "offer expired after 30 min"); return null; }
  return p ?? null;
}
export function optionsOf(planId: string): PlaceOption[] {
  return (db.query("SELECT json FROM option WHERE plan_id = ? ORDER BY idx").all(planId) as { json: string }[]).map((r) => JSON.parse(r.json));
}
export function votesOf(planId: string) {
  return db.query("SELECT * FROM vote WHERE plan_id = ?").all(planId) as { plan_id: string; handle: string; option_idx: number; via: "card" | "text"; at: string }[];
}
export function rsvpsOf(planId: string) {
  return db.query("SELECT * FROM rsvp WHERE plan_id = ?").all(planId) as { plan_id: string; handle: string; status: "in" | "out"; time_pref: string | null; at: string }[];
}
export function skippedOf(planId: string) {
  return (db.query("SELECT * FROM skipped WHERE plan_id = ? LIMIT 1").get(planId) as { place_id: string; name: string; reason: string; fact_id: number } | null) ?? null;
}
export function planEvents(planId: string) {
  return db.query("SELECT * FROM plan_event WHERE plan_id = ? ORDER BY id").all(planId) as { id: number; at: string; from_state: string; to_state: string; why: string }[];
}
function tally(planId: string, n: number): number[] {
  const t = new Array(n).fill(0);
  for (const v of votesOf(planId)) if (v.option_idx >= 0 && v.option_idx < n) t[v.option_idx]++;
  return t;
}
/** Vote order: most votes first, ties → search rank (idx). */
function voteOrder(planId: string, n: number): number[] {
  const t = tally(planId, n);
  return [...Array(n).keys()].sort((a, b) => t[b] - t[a] || a - b);
}
/** Party = organizer (always in) + everyone whose RSVP is "in". */
export function partyHandles(p: PlanRow): string[] {
  const s = new Set<string>([p.organizer]);
  for (const r of rsvpsOf(p.id)) if (r.status === "in") s.add(r.handle);
  return [...s];
}
const nameOf = (h: string) => memberByHandle(h)?.name ?? h;
const tried = (p: PlanRow): number[] => JSON.parse(p.tried || "[]");
const askVotes = (p: PlanRow): Record<string, "take" | "next"> => JSON.parse(p.ask_votes || "{}");

// ---------- writes ----------
function bump(planId: string, set = "", ...args: any[]) {
  db.query(`UPDATE plan SET rev = rev + 1${set ? ", " + set : ""} WHERE id = ?`).run(...args, planId);
}
function transition(p: PlanRow, to: PlanState, why: string, set = "", ...args: any[]) {
  const from = p.state;
  bump(p.id, `state = ?${set ? ", " + set : ""}`, to, ...args);
  db.query("INSERT INTO plan_event (plan_id, at, from_state, to_state, why) VALUES (?,?,?,?,?)").run(p.id, nowIso(), from, to, why);
  emit({ kind: "plan", planId: p.id, from, to, why });
  log.info(`plan ${p.id}: ${from} → ${to} (${why})`);
  p.state = to;
}
function note(p: PlanRow, why: string) {
  db.query("INSERT INTO plan_event (plan_id, at, from_state, to_state, why) VALUES (?,?,?,?,?)").run(p.id, nowIso(), p.state, p.state, why);
  emit({ kind: "plan", planId: p.id, from: p.state, to: p.state, why });
}

// ---------- offer ----------
export async function createOffer(chatId: string, organizer: string, it: { meal: string; day: string | null; start: string | null; end: string | null; area: string | null }): Promise<PlanRow | null> {
  const meal = it.meal || "dinner";
  const day = it.day && /^\d{4}-\d{2}-\d{2}$/.test(it.day) ? it.day : todayNY();
  const w = planWindow(meal, it.start, it.end);
  const id = newId("p");
  db.query(`INSERT INTO plan (id, chat_id, organizer, state, meal, day, window_start, window_end, chosen_time, default_time, area, created_at, booking_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, chatId, organizer, "offered", meal, day, w.windowStart, w.windowEnd, w.chosen, w.chosen, it.area ?? null, nowIso(), nameOf(organizer));
  db.query("INSERT INTO plan_event (plan_id, at, from_state, to_state, why) VALUES (?,?,?,?,?)").run(id, nowIso(), "idle", "offered", `${nameOf(organizer)} suggested ${meal}`);
  emit({ kind: "plan", planId: id, from: "idle", to: "offered", why: `${nameOf(organizer)} suggested ${meal}` });
  const p = getPlan(id)!;
  await sendCard(id, organizer, "offer", layoutFor(p));
  return p;
}

async function startVoting(p: PlanRow) {
  const facts = memory.factsFor(p.chat_id);
  const q: PlanQuery = { chatId: p.chat_id, meal: p.meal as PlanQuery["meal"], day: p.day, chosenTime: p.chosen_time, windowStart: p.window_start, windowEnd: p.window_end, area: p.area, partySize: partyHandles(p).length };
  transition(p, "voting", "organizer tapped 👍 Find spots");
  let res: SearchResult;
  try {
    res = await deps.searchPlaces(q, facts);
  } catch (e) {
    log.error("place search failed", e);
    transition(p, "cancelled", "Couldn't search right now", "status_line = ?", "Couldn't search right now — try again in a bit.");
    await editAll(p.id);
    return;
  }
  for (const f of res.filteredOut) emit({ kind: "filter", planId: p.id, name: f.name, reason: f.reason });
  const opts = res.options.slice(0, 3);
  if (!opts.length) {
    transition(p, "cancelled", "no place fits", "status_line = ?, filtered = ?", "I couldn't find a place that fits everyone.", JSON.stringify(res.filteredOut));
    await editAll(p.id);
    return;
  }
  const ins = db.query("INSERT OR REPLACE INTO option (plan_id, idx, place_id, name, address, phone, photo, price_level, rating, walk_min, why, json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  opts.forEach((o, i) => ins.run(p.id, i, o.placeId, o.name, o.address, o.phone, o.photo, o.priceLevel, o.rating, o.walkMin, o.why, JSON.stringify(o)));
  if (res.skipped) db.query("INSERT INTO skipped (plan_id, place_id, name, reason, fact_id) VALUES (?,?,?,?,?)").run(p.id, res.skipped.placeId, res.skipped.name, res.skipped.reason, res.skipped.factId);
  const deadline = new Date(Date.now() + planDeadlineMs()).toISOString();
  bump(p.id, "filtered = ?, deadline_at = ?", JSON.stringify(res.filteredOut), deadline);
  note(p, `${opts.length} options: ${opts.map((o) => o.name).join(", ")}${res.skipped ? ` · skipping ${res.skipped.name}` : ""}`);
  scheduleDeadline(p.id, deadline);
  const fresh = getPlan(p.id)!;
  await editCards(p.id, ["offer"], { caption: "🍽️ Plan started", subcaption: "Vote on the plan card below" });
  for (const m of members().filter((m) => m.cardCapable)) await sendCard(p.id, m.handle, "plan", layoutFor(fresh));
}

// ---------- votes / RSVPs ----------
function canVote(p: PlanRow | null): p is PlanRow {
  return !!p && p.state === "voting" && !p.voting_closed;
}
export function recordVote(planId: string, handle: string, idx: number, via: "card" | "text"): boolean {
  const p = getPlan(planId);
  if (!canVote(p) || !memberByHandle(handle)) return false;
  const n = optionsOf(planId).length;
  if (!Number.isInteger(idx) || idx < 0 || idx >= n) return false;
  db.query("INSERT OR REPLACE INTO vote (plan_id, handle, option_idx, via, at) VALUES (?,?,?,?,?)").run(planId, handle, idx, via, nowIso());
  bump(planId);
  emit({ kind: "vote", planId, handle, name: nameOf(handle), optionIdx: idx, via });
  return true;
}
export function recordRsvp(planId: string, handle: string, status: "in" | "out", timePref: string | null, via: "card" | "text"): boolean {
  const p = getPlan(planId);
  if (!canVote(p) || !memberByHandle(handle)) return false;
  const prev = rsvpsOf(planId).find((r) => r.handle === handle);
  const tp = validHHMM(timePref) && chips(p).includes(timePref) ? timePref : prev?.time_pref ?? null;
  db.query("INSERT OR REPLACE INTO rsvp (plan_id, handle, status, time_pref, at) VALUES (?,?,?,?,?)").run(planId, handle, status, tp, nowIso());
  bump(planId);
  emit({ kind: "rsvp", planId, handle, name: nameOf(handle), status, timePref: tp, via });
  if (tp) recomputeChosen(planId);
  return true;
}
function recordTime(p: PlanRow, handle: string, time: string): boolean {
  if (!canVote(p) || !chips(p).includes(time)) return false;
  const prev = rsvpsOf(p.id).find((r) => r.handle === handle);
  db.query("INSERT OR REPLACE INTO rsvp (plan_id, handle, status, time_pref, at) VALUES (?,?,?,?,?)").run(p.id, handle, prev?.status ?? "in", time, nowIso());
  emit({ kind: "rsvp", planId: p.id, handle, name: nameOf(handle), status: prev?.status ?? "in", timePref: time, via: "card" });
  recomputeChosen(p.id);
  return true;
}
/** Chosen time: the organizer's chip if tapped, else the most-picked chip, else the default. */
function recomputeChosen(planId: string) {
  const p = getPlan(planId)!;
  const rs = rsvpsOf(planId).filter((r) => r.time_pref);
  const org = rs.find((r) => r.handle === p.organizer)?.time_pref;
  let chosen = org ?? p.default_time;
  if (!org && rs.length) {
    const c = new Map<string, number>();
    for (const r of rs) c.set(r.time_pref!, (c.get(r.time_pref!) ?? 0) + 1);
    chosen = [...c.entries()].sort((a, b) => b[1] - a[1] || toMin(a[0]) - toMin(b[0]))[0][0];
  }
  bump(planId, "chosen_time = ?", chosen);
}

// ---------- booking + calls ----------
function callWindow(p: PlanRow) {
  const c = toMin(p.chosen_time);
  return { start: fromMin(c - 30), end: fromMin(c + 30) };
}
function inWindow(p: PlanRow, t: string): boolean {
  return Math.abs(toMin(t) - toMin(p.chosen_time)) <= 30;
}

/** Place the next call in vote order. State flips synchronously before any await, so a double tap can't dial twice. */
async function callNext(p: PlanRow, why: string): Promise<void> {
  const opts = optionsOf(p.id);
  const done = tried(p);
  let next: number | null = null;
  for (const i of voteOrder(p.id, opts.length)) {
    if (done.includes(i)) continue;
    if (!deps.isOpen(opts[i], p.day, p.chosen_time)) { note(p, `skipping ${opts[i].name}: closed at ${fmt12(p.chosen_time)}`); continue; }
    next = i;
    break;
  }
  if (next === null || p.attempt >= MAX_CALLS) {
    transition(p, "handed_back", p.attempt >= MAX_CALLS ? `${MAX_CALLS} calls made, none booked` : "no more places to try", "status_line = ?", "I couldn't get a table. Here are the numbers:");
    await editAll(p.id);
    return;
  }
  const o = opts[next];
  const attempt = p.attempt + 1;
  const w = callWindow(p);
  const party = partyHandles(p);
  const org = memberByHandle(p.organizer);
  transition(p, "calling", `${why} → calling ${o.name} (attempt ${attempt})`, "attempt = ?, call_idx = ?, tried = ?, ask_time = NULL, ask_votes = '{}', status_line = ?",
    attempt, next, JSON.stringify([...done, next]), attempt > 1 ? `${why} — trying ${o.name}…` : `📞 Calling ${o.name}…`);
  void editAll(p.id);
  const req: CallRequest = {
    planId: p.id, attempt, option: o, partySize: party.length, chosenTime: p.chosen_time, windowStart: w.start, windowEnd: w.end,
    bookingName: p.booking_name || nameOf(p.organizer), callbackNumber: org && isPhone(org.handle) ? org.handle : "",
    allergies: memory.allergiesFor(p.chat_id, party),
  };
  decision({ from: "plan", preview: `call ${o.name} for ${party.length} at ${fmt12(p.chosen_time)}`, rules: [`attempt ${attempt}/${MAX_CALLS}`, `window ${fmt12(w.start)}–${fmt12(w.end)}`], action: "call" });
  let r: Awaited<ReturnType<Deps["placeCall"]>>;
  try { r = await deps.placeCall(req); } catch (e: any) { r = { ok: false, error: e?.message ?? String(e) }; }
  if (!r.ok) {
    const cur = getPlan(p.id)!;
    if (cur.state === "calling" && cur.attempt === attempt) {
      transition(cur, "handed_back", `call couldn't be placed: ${r.error ?? "unknown"}`, "status_line = ?", "I couldn't place the call. Here are the numbers:");
      await editAll(p.id);
    }
  }
}

/** Registered with calls.setCallResultHandler. Code decides the outcome (spec §12). Idempotent per (plan, attempt). */
export async function onCallResult(r: CallResult): Promise<void> {
  const p = getPlan(r.planId);
  if (!p) { log.warn(`call result for unknown plan ${r.planId}`); return; }
  if (p.state !== "calling" || r.attempt !== p.attempt) { log.info(`call result ignored for ${p.id} (state ${p.state}, attempt ${r.attempt} vs ${p.attempt})`); return; }
  const o = optionsOf(p.id)[p.call_idx ?? 0];
  const party = r.partySize && r.partySize > 0 ? r.partySize : partyHandles(p).length;
  switch (r.status) {
    case "booked": {
      const t = validHHMM(r.time) ? r.time : p.chosen_time;
      if (inWindow(p, t)) {
        transition(p, "booked", `${o.name} booked ${fmt12(t)} for ${party}`, "booked_place_id = ?, booked_time = ?, booked_party = ?, status_line = NULL", o.placeId, t, party);
        await editAll(p.id);
        await celebrate(p.id);
      } else {
        transition(p, "asking_group", `${o.name} booked ${fmt12(t)} — outside the window, asking the group`, "ask_time = ?", t);
        await editAll(p.id);
      }
      return;
    }
    case "offered_other_time": {
      const t = validHHMM(r.time) ? r.time : null;
      transition(p, "asking_group", `${o.name} offered ${t ? fmt12(t) : "another time"} — asking the group`, "ask_time = ?", t);
      await editAll(p.id);
      return;
    }
    case "card_required":
      transition(p, "handed_back", `${o.name} wants a card — handing back`, "status_line = ?", `${o.name} needs a card to hold it. Here are the numbers:`);
      await editAll(p.id);
      return;
    default: {
      const label: Record<string, string> = { full: "is full", no_reservations: "doesn't take reservations", voicemail: "went to voicemail", no_answer: "didn't answer", other: "couldn't book" };
      await callNext(p, `${o.name} ${label[r.status] ?? "couldn't book"}`);
    }
  }
}

async function celebrate(planId: string) {
  const p = getPlan(planId)!;
  const T = getTransport();
  if (!T) return;
  const o = optionsOf(planId)[p.call_idx ?? 0];
  const ics = new TextEncoder().encode(icsFor(planId) ?? "");
  for (const m of members().filter((m) => m.cardCapable)) {
    await T.sendEffect(m.handle, `Booked! 🎉 ${o.name} · ${fmt12(p.booked_time)} · table for ${p.booked_party}`);
    await T.sendAttachment(m.handle, ics, "dinner.ics", "text/calendar");
  }
}

export function icsFor(planId: string): string | null {
  const p = getPlan(planId);
  if (!p || p.state !== "booked" || !p.booked_time) return null;
  const o = optionsOf(planId)[p.call_idx ?? 0];
  const local = p.day.replace(/-/g, "") + "T" + p.booked_time.replace(":", "") + "00";
  const endMin = toMin(p.booked_time) + 90;
  const end = endMin >= 1440 ? local : p.day.replace(/-/g, "") + "T" + fromMin(endMin).replace(":", "") + "00";
  const esc = (s: string) => s.replace(/[\\,;]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tablemate//EN", "BEGIN:VEVENT",
    `UID:${p.id}@tablemate`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART;TZID=America/New_York:${local}`, `DTEND;TZID=America/New_York:${end}`,
    `SUMMARY:${esc(`${p.meal[0].toUpperCase()}${p.meal.slice(1)} at ${o.name}`)}`,
    `LOCATION:${esc(o.address)}`, `DESCRIPTION:${esc(`Table for ${p.booked_party} under ${p.booking_name}. Booked by Tablemate.`)}`,
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

// ---------- card taps ----------
export type ActResult = { status: number; body: { ok: boolean; toast?: string; error?: string } };
const ok = (toast?: string): ActResult => ({ status: 200, body: { ok: true, toast } });
const no = (status: number, error: string): ActResult => ({ status, body: { ok: false, error, toast: error } });

export async function act(planId: string, handle: string, action: string, body: any): Promise<ActResult> {
  const p = getPlan(planId);
  if (!p) return no(404, "This plan is gone.");
  if (!memberByHandle(handle)) return no(403, "Not a member.");
  const isOrg = handle === p.organizer;
  switch (action) {
    case "offer_yes":
      if (!isOrg) return no(403, "Only the organizer can start this.");
      if (p.state !== "offered") return no(409, "Already started.");
      await startVoting(p);
      return ok("Finding spots… 🔎");
    case "offer_no":
      if (!isOrg) return no(403, "Only the organizer can do that.");
      if (p.state !== "offered") return no(409, "Already started.");
      transition(p, "idle", "organizer tapped Not now");
      await editCards(p.id, ["offer"], { caption: "👌 No plan for now", subcaption: "I'll stay quiet" });
      return ok("No worries 👌");
    case "vote":
      if (!recordVote(p.id, handle, Number(body?.idx), "card")) return no(409, p.voting_closed ? "Voting is closed." : "Voting isn't open.");
      await editAll(p.id);
      return ok("Voted ✓");
    case "rsvp": {
      const s = body?.status === "out" ? "out" : body?.status === "in" ? "in" : null;
      if (!s || !recordRsvp(p.id, handle, s, null, "card")) return no(409, "Voting isn't open.");
      await editAll(p.id);
      return ok(s === "in" ? "You're in 🙌" : "Got it — maybe next time");
    }
    case "time":
      if (!recordTime(p, handle, String(body?.time ?? ""))) return no(409, "That time isn't available.");
      await editAll(p.id);
      return ok("Time noted ⏰");
    case "book": {
      // Rule 1: only the organizer's ✅ tap (their own card token) can start a call.
      if (!isOrg) { decision({ from: nameOf(handle), preview: "tapped Book", rules: ["rule 1: organizer only"], action: "reject" }); return no(403, `Only ${nameOf(p.organizer)} can book.`); }
      if (p.state !== "voting") return no(409, "Already booking.");
      if (!votesOf(p.id).length) return no(409, "Vote first.");
      transition(p, "booking", `${nameOf(handle)} tapped ✅ Book`, "booked_party = ?", partyHandles(p).length);
      await callNext(getPlan(p.id)!, "organizer tapped Book");
      return ok("Calling now 📞");
    }
    case "take_time":
    case "try_next": {
      if (p.state !== "asking_group") return no(409, "Nothing to decide right now.");
      if (!isOrg) {
        const v = askVotes(p); v[handle] = action === "take_time" ? "take" : "next";
        bump(p.id, "ask_votes = ?", JSON.stringify(v));
        await editAll(p.id);
        return ok(`Noted — ${nameOf(p.organizer)} decides`);
      }
      if (action === "take_time") {
        if (!p.ask_time) return no(409, "No time was offered.");
        const o = optionsOf(p.id)[p.call_idx ?? 0];
        transition(p, "booked", `group took ${fmt12(p.ask_time)} at ${o.name} (organizer tap)`, "booked_place_id = ?, booked_time = ?, booked_party = ?, status_line = NULL", o.placeId, p.ask_time, partyHandles(p).length);
        await editAll(p.id);
        await celebrate(p.id);
        return ok("Booked 🎉");
      }
      await callNext(p, "group said try the next place");
      return ok("Trying the next place 📞");
    }
    case "cancel":
      if (!isOrg) return no(403, "Only the organizer can cancel.");
      if (!ACTIVE.includes(p.state)) return no(409, "Nothing to cancel.");
      transition(p, "cancelled", `${nameOf(handle)} cancelled the plan`, "status_line = ?", "Plan cancelled.");
      await editAll(p.id);
      return ok("Cancelled");
    default:
      return no(400, "Unknown action.");
  }
}

// ---------- cards ----------
export function layoutFor(p: PlanRow): { caption: string; subcaption: string } {
  const opts = optionsOf(p.id);
  const o = p.call_idx != null ? opts[p.call_idx] : undefined;
  const title = `${p.meal[0].toUpperCase()}${p.meal.slice(1)} ${dayLabel(p.day, p.meal)}`;
  switch (p.state) {
    case "offered": return { caption: `🍽️ ${title}?`, subcaption: "Want me to find spots near campus?" };
    case "voting": {
      const t = tally(p.id, opts.length);
      const lead = t.some((x) => x > 0) ? opts[voteOrder(p.id, opts.length)[0]]?.name : null;
      const n = partyHandles(p).length;
      return { caption: p.voting_closed ? `⏰ ${title} · voting closed` : `🍽️ ${title}`, subcaption: `${n} in · ${lead ? `${lead} leads` : "tap to vote"} · ${fmt12(p.chosen_time)}` };
    }
    case "booking":
    case "calling": return { caption: `📞 Calling ${o?.name ?? "…"}`, subcaption: p.status_line ?? `${fmt12(p.chosen_time)} · table for ${partyHandles(p).length}` };
    case "asking_group": return { caption: `${o?.name ?? "They"} offered ${p.ask_time ? fmt12(p.ask_time) : "another time"}`, subcaption: "Take it or try the next place?" };
    case "booked": return { caption: `✅ ${o?.name ?? "Booked"} · ${fmt12(p.booked_time)}`, subcaption: `Table for ${p.booked_party} · under ${p.booking_name}` };
    case "handed_back": return { caption: "I couldn't get a table", subcaption: "Tap for the numbers" };
    case "cancelled": return { caption: `${title} · cancelled`, subcaption: p.status_line ?? "Plan cancelled" };
    default: return { caption: `${title}`, subcaption: "No plan for now" };
  }
}

/** Edit every member's plan card in place (caption/subcaption); open pages pick up the rest by polling /state. */
export async function editAll(planId: string): Promise<void> {
  const p = getPlan(planId);
  if (!p) return;
  await editCards(planId, ["plan"], layoutFor(p));
}

// ---------- view model (card page + /state) ----------
export function viewFor(planId: string, handle: string) {
  const p = getPlan(planId);
  if (!p) return null;
  const opts = optionsOf(planId);
  const t = tally(planId, opts.length);
  const mine = votesOf(planId).find((v) => v.handle === handle)?.option_idx ?? null;
  const rs = rsvpsOf(planId);
  const myR = rs.find((r) => r.handle === handle) ?? null;
  const order = voteOrder(planId, opts.length);
  const leader = t.some((x) => x > 0) ? order[0] : null;
  const party = partyHandles(p);
  const sk = skippedOf(planId);
  const cur = p.call_idx != null ? opts[p.call_idx] : null;
  const av = askVotes(p);
  const money = (n: number | null) => (n == null ? "" : n <= 0 ? "Free" : "$".repeat(n));
  const tok = planToken(planId, handle);
  return {
    planId, rev: p.rev, state: p.state, token: tok,
    me: { handle, name: nameOf(handle), isOrganizer: handle === p.organizer },
    organizerName: nameOf(p.organizer),
    title: `${p.meal[0].toUpperCase()}${p.meal.slice(1)} ${dayLabel(p.day, p.meal)}`,
    meal: p.meal,
    options: opts.map((o, i) => ({
      idx: i, name: o.name, emoji: o.emoji || "🍽️", photo: o.photo,
      meta: [money(o.priceLevel), o.rating != null ? `★${o.rating.toFixed(1)}` : "", `${o.walkMin} min walk`].filter(Boolean).join(" · "),
      why: o.why, votes: t[i], mine: mine === i, phone: o.phone, address: o.address, mapsUri: o.mapsUri,
    })),
    skipped: sk ? `Skipping ${sk.name}: ${sk.reason}` : null,
    inCount: party.length, myRsvp: handle === p.organizer ? "in" : myR?.status ?? null,
    chips: chips(p).map((c) => ({ time: c, label: fmt12(c).replace(" PM", "").replace(" AM", ""), count: rs.filter((r) => r.time_pref === c).length, chosen: c === p.chosen_time, mine: myR?.time_pref === c })),
    chosenTime: p.chosen_time, chosenLabel: fmt12(p.chosen_time),
    leaderIdx: leader, votingClosed: !!p.voting_closed,
    canBook: handle === p.organizer && p.state === "voting" && leader != null,
    bookLabel: leader != null ? `✅ Book ${opts[leader].name} ${fmt12(p.chosen_time).replace(" PM", "").replace(" AM", "")} for ${party.length}` : "✅ Book (vote first)",
    statusLine: p.status_line, attempt: p.attempt,
    calling: cur ? { name: cur.name, emoji: cur.emoji } : null,
    ask: p.state === "asking_group" ? { time: p.ask_time, label: p.ask_time ? fmt12(p.ask_time) : null, take: Object.values(av).filter((x) => x === "take").length, next: Object.values(av).filter((x) => x === "next").length, canTryNext: p.attempt < MAX_CALLS } : null,
    booked: p.state === "booked" && cur ? {
      name: cur.name, emoji: cur.emoji, time: p.booked_time, timeLabel: fmt12(p.booked_time), party: p.booked_party, under: p.booking_name,
      address: cur.address, mapsUri: cur.mapsUri || `https://maps.google.com/?q=${encodeURIComponent(cur.name + " " + cur.address)}`,
      icsUrl: `/plan/${planId}/invite.ics?t=${tok}`,
    } : null,
    numbers: p.state === "handed_back" ? opts.map((o) => ({ name: o.name, phone: o.phone })) : [],
  };
}
export type PlanView = NonNullable<ReturnType<typeof viewFor>>;

// ---------- deadline + boot ----------
const timers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleDeadline(planId: string, at: string) {
  const old = timers.get(planId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => { timers.delete(planId); void onDeadline(planId); }, Math.max(0, Date.parse(at) - Date.now()));
  (t as any).unref?.();
  timers.set(planId, t);
}
/** The deadline only closes voting and nudges the organizer. It never books (rule 1). */
async function onDeadline(planId: string) {
  const p = getPlan(planId);
  if (!p || p.state !== "voting" || p.voting_closed) return;
  bump(planId, "voting_closed = 1, status_line = ?", `Voting closed — ${nameOf(p.organizer)}, tap ✅ Book`);
  note(p, "deadline: voting closed, nudging the organizer (never books on its own)");
  await editAll(planId);
}

export function initPlans() {
  calls.setCallResultHandler((r) => onCallResult(r));
  // Restart-safe: a plan stuck mid-call has no live call any more → hand it back. Late webhooks are ignored idempotently.
  for (const p of db.query("SELECT * FROM plan WHERE state IN ('booking','calling')").all() as PlanRow[]) {
    transition(p, "handed_back", "restarted mid-call", "status_line = ?", "I lost track of the call. Here are the numbers:");
  }
  for (const p of db.query("SELECT * FROM plan WHERE state = 'voting' AND voting_closed = 0 AND deadline_at IS NOT NULL").all() as PlanRow[]) scheduleDeadline(p.id, p.deadline_at!);
}
