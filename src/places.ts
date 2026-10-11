// Restaurant search: Google Places API (New) Text Search → code filters (spec §11) → score → top 3. Implements PlacesModule.
import { existsSync, mkdirSync } from "fs";
import { db, nowIso } from "./db";
import { log } from "./events";
import type { Fact, PlaceOption, PlanQuery, SearchResult, Skipped } from "./contracts";
import { factLabel } from "./memory";
import { cuisineEmoji, dislikeMatches, likeCuisine } from "./cuisine";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const realFetch: FetchFn = (url, init) => fetch(url, init);
let fetchFn: FetchFn = realFetch;
/** Tests inject a fake fetch (no network); pass null to restore the real one. */
export function setPlacesFetch(fn: FetchFn | null) { fetchFn = fn ?? realFetch; }

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = ["id", "displayName", "formattedAddress", "location", "rating", "userRatingCount", "priceLevel", "regularOpeningHours",
  "nationalPhoneNumber", "internationalPhoneNumber", "photos", "primaryType", "primaryTypeDisplayName", "reservable",
  "servesVegetarianFood", "servesDinner", "googleMapsUri"].map((f) => `places.${f}`).join(",");
const AREA = "near Franklin Street Chapel Hill NC";
const CACHE_MS = 24 * 3600_000;
const TIMEOUT_MS = 8000;
const MAX_WHY = 48;
const PRICE: Record<string, number> = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
const MODERATE = 2;
const CHEAP_RE = /cheap|broke|budget|inexpensive|tight|\$/;

const campus = () => ({ lat: Number(process.env.CAMPUS_LAT || 35.9121), lng: Number(process.env.CAMPUS_LNG || -79.0512) });
const mediaDir = () => `${process.env.TM_DATA_DIR || "data"}/media`;

type Point = { day: number; hour: number; minute: number };
type Hours = { periods?: { open: Point; close?: Point }[] };
export type RawPlace = {
  id: string; displayName?: { text: string }; formattedAddress?: string; location?: { latitude: number; longitude: number };
  rating?: number; userRatingCount?: number; priceLevel?: string; regularOpeningHours?: Hours; internationalPhoneNumber?: string;
  photos?: { name: string }[]; primaryType?: string; primaryTypeDisplayName?: { text: string }; reservable?: boolean;
  servesVegetarianFood?: boolean; servesDinner?: boolean; googleMapsUri?: string;
};

// ---------- HTTP + cache ----------
let cacheReady = false;
export function initPlaces(): void {
  db.exec("CREATE TABLE IF NOT EXISTS places_cache (query_key TEXT PRIMARY KEY, json TEXT, at TEXT)");
  cacheReady = true;
}
function ensureCache() {
  if (!cacheReady) initPlaces();
}

async function searchText(body: Record<string, unknown>): Promise<RawPlace[]> {
  ensureCache();
  const key = JSON.stringify(body);
  const cached = db.query("SELECT json, at FROM places_cache WHERE query_key = ?").get(key) as { json: string; at: string } | null;
  if (cached && Date.now() - Date.parse(cached.at) < CACHE_MS) return JSON.parse(cached.json).places ?? [];
  try {
    const res = await fetchFn(SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY || "", "X-Goog-FieldMask": FIELD_MASK },
      body: key,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.text();
    const places = (JSON.parse(json).places ?? []) as RawPlace[];
    db.query("INSERT OR REPLACE INTO places_cache (query_key, json, at) VALUES (?,?,?)").run(key, json, nowIso());
    return places;
  } catch (e: any) {
    if (cached) {
      log.warn(`places search failed (${e?.message ?? e}); using cache from ${cached.at}`);
      return JSON.parse(cached.json).places ?? [];
    }
    throw new Error(`Places search failed (${e?.message ?? e}) and nothing is cached for "${body.textQuery}"`);
  }
}

async function downloadPhoto(p: RawPlace): Promise<string | null> {
  const name = p.photos?.[0]?.name;
  if (!name) return null;
  const file = `${p.id}.jpg`;
  const path = `${mediaDir()}/${file}`;
  if (existsSync(path)) return `/media/${file}`;
  try {
    const res = await fetchFn(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=400&key=${process.env.GOOGLE_PLACES_API_KEY || ""}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    mkdirSync(mediaDir(), { recursive: true });
    await Bun.write(path, await res.arrayBuffer());
    return `/media/${file}`;
  } catch {
    return null;
  }
}

// ---------- helpers ----------
const WEEK = 7 * 1440;
/** Is the place open at HH:MM on YYYY-MM-DD (local America/New_York wall time)? Handles overnight periods and 24h places. */
export function isOpenAt(hours: Hours | undefined, day: string, hhmm: string): boolean {
  const periods = hours?.periods;
  if (!periods?.length) return false;
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  const [h, m] = hhmm.split(":").map(Number);
  const t = dow * 1440 + h * 60 + m;
  for (const p of periods) {
    if (!p.close) return true; // Places encodes "open 24 hours" as a single open period with no close
    const o = p.open.day * 1440 + p.open.hour * 60 + p.open.minute;
    let c = p.close.day * 1440 + p.close.hour * 60 + p.close.minute;
    if (c <= o) c += WEEK; // wraps past Saturday night
    if ((t >= o && t < c) || (t + WEEK >= o && t + WEEK < c)) return true;
  }
  return false;
}

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

const walkMinOf = (p: RawPlace) => p.location ? Math.round(haversineM(campus(), { lat: p.location.latitude, lng: p.location.longitude }) / 80) : 99;
const priceOf = (p: RawPlace): number | null => (p.priceLevel && p.priceLevel in PRICE ? PRICE[p.priceLevel] : null);
const scoreOf = (p: RawPlace) => (p.rating ?? 0) * Math.log10((p.userRatingCount ?? 0) + 1) + (p.reservable === true ? 0.5 : 0) - walkMinOf(p) / 20;
const e164 = (s: string) => "+" + s.replace(/\D/g, "");
const first = (f: Fact) => f.name.split(" ")[0];

function whyLine(p: RawPlace, diet: Fact[], budget: Fact | null, likes: Fact[]): string {
  const parts: string[] = [];
  const vegan = diet.find((f) => f.value === "vegan");
  const veg = diet.find((f) => f.value === "vegetarian");
  if (vegan) parts.push("Veggie options · vegan not confirmed");
  else if (veg) parts.push(`Veggie menu · ${first(veg)}'s vegetarian`);
  const price = priceOf(p);
  if (budget && price != null) parts.push(`${"$".repeat(Math.max(1, price))} · fits ${first(budget)}'s budget`);
  const liked = likes.find((f) => { const c = likeCuisine(f.value); return !!c && dislikeMatches(p.primaryType, c); });
  if (liked) parts.push(`${first(liked)} likes ${likeCuisine(liked.value)}`);
  if (p.reservable === true) parts.push("Takes reservations");
  parts.push(`${walkMinOf(p)} min walk`);
  let why = "";
  for (const part of parts) {
    const next = why ? `${why} · ${part}` : part;
    if (next.length <= MAX_WHY) why = next;
  }
  return why || parts[parts.length - 1].slice(0, MAX_WHY);
}

// ---------- search ----------
export async function searchPlaces(q: PlanQuery, facts: Fact[]): Promise<SearchResult> {
  const diet = facts.filter((f) => f.kind === "diet" && (f.value === "vegetarian" || f.value === "vegan"));
  const dislikes = facts.filter((f) => f.kind === "dislike");
  const budget = facts.find((f) => f.kind === "budget" && CHEAP_RE.test(f.value)) ?? null;
  const likes = facts.filter((f) => f.kind === "like" && likeCuisine(f.value));

  const c = campus();
  const base: Record<string, unknown> = {
    includedType: "restaurant",
    locationBias: { circle: { center: { latitude: c.lat, longitude: c.lng }, radius: 1500 } },
    pageSize: 20,
  };
  if (budget) base.priceLevels = ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE"];
  const queries = [`restaurant ${AREA}`];
  if (likes.length) queries.push(`${likeCuisine(likes[0].value)} restaurant ${AREA}`);

  const byId = new Map<string, RawPlace>();
  for (const textQuery of queries) {
    for (const p of await searchText({ textQuery, ...base })) if (p.id && !byId.has(p.id)) byId.set(p.id, p);
  }
  const all = [...byId.values()];

  const kept: RawPlace[] = [];
  const filteredOut: { name: string; reason: string }[] = [];
  let skipped: (Skipped & { score: number }) | null = null;
  for (const p of all) {
    const name = p.displayName?.text ?? p.id;
    let reason: string | null = null;
    let fact: Fact | null = null;
    const price = priceOf(p);
    const disliked = dislikes.find((f) => dislikeMatches(p.primaryType, f.value));
    if (!p.internationalPhoneNumber) reason = "no phone number";
    else if (!isOpenAt(p.regularOpeningHours, q.day, q.chosenTime)) reason = `closed at ${q.chosenTime}`;
    else if (q.meal === "dinner" && p.servesDinner === false) reason = "doesn't serve dinner";
    else if (diet.length && p.servesVegetarianFood !== true) fact = diet[0];
    else if (disliked) fact = disliked;
    else if (budget && price != null && price > MODERATE) fact = budget;
    else if (p.reservable === false) reason = "doesn't take reservations";
    if (fact) {
      reason = factLabel(fact);
      const score = scoreOf(p);
      if (!skipped || score > skipped.score) skipped = { placeId: p.id, name, reason, factId: fact.id, score };
    }
    if (reason) filteredOut.push({ name, reason });
    else kept.push(p);
  }

  kept.sort((a, b) => scoreOf(b) - scoreOf(a));
  const picked: RawPlace[] = [];
  const types = new Set<string>();
  for (const p of kept) {
    if (picked.length < 3 && !types.has(p.primaryType ?? "")) { picked.push(p); types.add(p.primaryType ?? ""); }
  }
  for (const p of kept) if (picked.length < 3 && !picked.includes(p)) picked.push(p);
  picked.sort((a, b) => scoreOf(b) - scoreOf(a));

  const options: PlaceOption[] = [];
  for (const p of picked) {
    options.push({
      placeId: p.id,
      name: p.displayName?.text ?? p.id,
      address: p.formattedAddress ?? "",
      phone: e164(p.internationalPhoneNumber!),
      mapsUri: p.googleMapsUri ?? "",
      lat: p.location?.latitude ?? 0,
      lng: p.location?.longitude ?? 0,
      priceLevel: priceOf(p),
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
      walkMin: walkMinOf(p),
      primaryType: p.primaryType ?? "restaurant",
      cuisineLabel: p.primaryTypeDisplayName?.text ?? "Restaurant",
      emoji: cuisineEmoji(p.primaryType, p.primaryTypeDisplayName?.text, p.displayName?.text),
      photo: await downloadPhoto(p),
      reservable: p.reservable ?? null,
      why: whyLine(p, diet, budget, likes),
    });
  }
  const { score: _score, ...skip } = skipped ?? ({} as any);
  return { options, skipped: skipped ? (skip as Skipped) : null, considered: all.length, filteredOut };
}
